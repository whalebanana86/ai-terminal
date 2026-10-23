//! 앱 핵심 로직: 저장소 ↔ 워크트리 ↔ 세션 ↔ 실행 연결. Tauri 에 의존하지 않아 통합 테스트가 가능하다.

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::db::{now_ms, Db, ExecutionRow, RepoRow, SessionLink};
use crate::git::{self, RepoLocation, Worktree};
use crate::graph::{self, GraphRow};
use crate::chat::{ChatInfo, ChatManager, StartChat};
use crate::procs::LiveRun;
use crate::pty::{PtyManager, SpawnSpec};
use crate::sessions::{self, SessionIndex, SessionMeta, Transcript};
use crate::watch::WatchTarget;

pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    #[serde(flatten)]
    pub row: RepoRow,
    pub exists: bool,
    pub worktrees: Vec<Worktree>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSession {
    #[serde(flatten)]
    pub meta: SessionMeta,
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    /// 세션이 (지금) 일하는 워크트리 최상위 폴더 (정규화된 실제 경로)
    pub worktree_path: Option<String>,
    /// 기록에 적힌 형태의 워크트리 경로. /tmp → /private/tmp 처럼 심볼릭 링크 경로로 기록되었을 때만 값이 있다.
    pub worktree_alias: Option<String>,
    /// 대화 도중 다른 워크트리(또는 저장소)로 옮겨 갔는지. 그렇다면 시작 브랜치는 다른 곳의 값이다.
    pub cwd_moved: bool,
    /// 기록된 cwd 가 지금도 디스크에 있는지
    pub cwd_exists: bool,
    /// 워크트리의 **현재** 브랜치 (Git 실시간). detached 면 None
    pub current_branch: Option<String>,
    pub current_head: Option<String>,
    pub current_detached: bool,
    /// 앱에서 실행 중인 실행 id
    pub running_exec_id: Option<String>,
    /// 최근에 함께 일한 다른 워크트리(그 워크트리 목록에도 보인다)
    pub other_worktrees: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub rows: Vec<GraphRow>,
    pub refs: Vec<git::GitRef>,
    pub worktrees: Vec<Worktree>,
    pub limit: usize,
    pub truncated: bool,
    /// 요청한 워크트리의 HEAD
    pub head: Option<String>,
    pub head_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecInfo {
    pub id: String,
    pub session_id: Option<String>,
    pub agent: String,
    pub kind: String,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub branch_at_start: Option<String>,
    pub head_at_start: Option<String>,
    pub started_at: i64,
    pub pid: Option<u32>,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

pub struct StartRequest {
    pub agent: String,
    /// new | resume
    pub mode: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// 외부에서 실행 중인 세션이라도 열기(사용자가 확인함)
    pub force: bool,
    /// 새 세션의 첫 지시(있으면 CLI 인자로 넘긴다)
    pub prompt: Option<String>,
}

pub struct AppCore {
    pub db: Db,
    pub pty: PtyManager,
    pub chats: ChatManager,
    /// 마지막으로 감지한 실행 중 에이전트(외부 포함)
    live: Mutex<Vec<LiveRun>>,
    /// 세션 열기(재개·채팅)를 한 번에 하나씩: 같은 세션을 두 번 띄우는 경쟁 방지
    open_lock: Mutex<()>,
    index: Mutex<SessionIndex>,
    locate_cache: Mutex<HashMap<String, (std::time::Instant, Option<RepoLocation>)>>,
    /// 실행 id → 실행 정보 (앱이 띄운 것)
    execs: Mutex<HashMap<String, ExecInfo>>,
    /// 최근 목록 (진행 중인 Codex 새 실행 연결용)
    last_sessions: Mutex<Vec<SessionMeta>>,
    /// 앱이 아는 워크트리 경로 (명령 인자 범위 검증용)
    known: Mutex<(Option<std::time::Instant>, std::collections::HashSet<String>)>,
    /// 세션에서 본 워크트리 경로
    session_worktrees: Mutex<std::collections::HashSet<String>>,
    events: EventSink,
}

/// 기록된 cwd 가 심볼릭 링크 경로(/tmp/x/sub)이고 워크트리가 실제 경로(/private/tmp/x)일 때,
/// 기록 형태의 워크트리 경로(/tmp/x)를 돌려준다.
pub fn path_alias(raw_cwd: &str, canonical_worktree: &str) -> Option<String> {
    let canon = std::fs::canonicalize(raw_cwd).ok()?;
    let canon = canon.to_string_lossy();
    if canon == raw_cwd {
        return None;
    }
    let suffix = canon.strip_prefix(canonical_worktree)?;
    let alias = raw_cwd.strip_suffix(suffix)?;
    (!alias.is_empty() && alias != canonical_worktree).then(|| alias.to_string())
}

fn repo_name(main_path: &str) -> String {
    Path::new(main_path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| main_path.to_string())
}

impl AppCore {
    pub fn new(db: Db, events: EventSink) -> Arc<Self> {
        Arc::new(Self {
            db,
            pty: PtyManager::default(),
            chats: ChatManager::default(),
            live: Mutex::new(Vec::new()),
            open_lock: Mutex::new(()),
            index: Mutex::new(SessionIndex::default()),
            locate_cache: Mutex::new(HashMap::new()),
            execs: Mutex::new(HashMap::new()),
            last_sessions: Mutex::new(Vec::new()),
            known: Mutex::new((None, Default::default())),
            session_worktrees: Mutex::new(Default::default()),
            events,
        })
    }

    fn emit(&self, name: &str, payload: Value) {
        (self.events)(name, payload);
    }

    /// cwd → 저장소 위치. 60초 안의 결과는 다시 쓰되, 저장소 폴더가 사라졌으면 다시 확인한다.
    pub fn locate_cached(&self, cwd: &str) -> Option<RepoLocation> {
        const TTL: std::time::Duration = std::time::Duration::from_secs(60);
        if let Some((at, hit)) = self.locate_cache.lock().get(cwd).cloned() {
            let still_valid = match &hit {
                Some(loc) => Path::new(&loc.toplevel).is_dir(),
                None => true,
            };
            if still_valid && at.elapsed() < TTL {
                return hit;
            }
        }
        let loc = git::locate(Path::new(cwd)).ok().flatten();
        self.locate_cache.lock().insert(cwd.to_string(), (std::time::Instant::now(), loc.clone()));
        loc
    }

    // ───────────── 경로 범위 검증 ─────────────

    fn refresh_known(&self) {
        let mut set: std::collections::HashSet<String> = self.session_worktrees.lock().clone();
        if let Ok(repos) = self.db.repos() {
            for r in repos {
                let probe = if Path::new(&r.path).is_dir() { r.path.clone() } else { r.id.clone() };
                if let Ok(ws) = git::worktrees(Path::new(&probe)) {
                    set.extend(ws.into_iter().filter(|w| w.exists).map(|w| w.path));
                }
            }
        }
        *self.known.lock() = (Some(std::time::Instant::now()), set);
    }

    /// 웹뷰가 넘긴 경로가 앱이 아는 워크트리(또는 그 하위)인지. 아니면 Git·파일 명령을 거부한다.
    pub fn is_known_worktree(&self, path: &str) -> bool {
        let Ok(canon) = std::fs::canonicalize(path) else { return false };
        let canon = canon.to_string_lossy().into_owned();
        let check = |set: &std::collections::HashSet<String>| {
            set.iter().any(|k| canon == *k || canon.starts_with(&format!("{}/", k.trim_end_matches('/'))))
        };
        {
            let k = self.known.lock();
            if k.0.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(5)) && check(&k.1) {
                return true;
            }
        }
        // 모르는 경로면 한 번 새로 읽어 본다(방금 만든 워크트리 등).
        self.refresh_known();
        check(&self.known.lock().1)
    }

    pub fn ensure_known(&self, path: &str) -> Result<()> {
        if self.is_known_worktree(path) {
            Ok(())
        } else {
            bail!(tr!("등록된 저장소의 워크트리가 아닙니다: {path}", "Not a worktree of a registered repository: {path}"))
        }
    }

    // ───────────── 저장소 ─────────────

    pub fn add_repo(&self, path: &str) -> Result<RepoRow> {
        let loc = git::locate(Path::new(path))?.ok_or_else(|| anyhow!(tr!("Git 저장소가 아닙니다: {path}", "Not a Git repository: {path}")))?;
        let main = git::worktrees(Path::new(&loc.toplevel))?
            .into_iter()
            .find(|w| w.is_main)
            .map(|w| w.path)
            .unwrap_or(loc.toplevel.clone());
        let name = repo_name(&main);
        self.db.upsert_repo(&loc.common_dir, &main, &name, true)?;
        self.db.repos()?.into_iter().find(|r| r.id == loc.common_dir).ok_or_else(|| anyhow!(tr!("저장 실패", "Failed to save")))
    }

    pub fn list_repos(&self) -> Result<Vec<RepoSummary>> {
        let mut out = Vec::new();
        for row in self.db.repos()? {
            let probe = if Path::new(&row.path).is_dir() { row.path.clone() } else { row.id.clone() };
            let exists = Path::new(&row.id).is_dir();
            let (worktrees, error) = if exists {
                match git::worktrees(Path::new(&probe)) {
                    Ok(w) => (w, None),
                    Err(e) => (Vec::new(), Some(e.to_string())),
                }
            } else {
                (Vec::new(), Some(tr!("저장소 폴더를 찾을 수 없습니다", "Repository folder not found")))
            };
            out.push(RepoSummary { row, exists, worktrees, error });
        }
        Ok(out)
    }

    // ───────────── 세션 ─────────────

    pub fn scan_sessions(&self) -> Vec<SessionMeta> {
        let mut idx = self.index.lock();
        let mut all = idx.scan_claude();
        all.extend(idx.scan_codex());
        drop(idx);
        all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        *self.last_sessions.lock() = all.clone();
        all
    }

    pub fn list_sessions(&self) -> Result<Vec<LinkedSession>> {
        let metas = self.scan_sessions();
        let links: HashMap<String, SessionLink> = self.db.links()?.into_iter().map(|l| (l.session_id.clone(), l)).collect();
        let repos: HashMap<String, RepoRow> = self.db.repos()?.into_iter().map(|r| (r.id.clone(), r)).collect();
        let mut wt_cache: HashMap<String, Vec<Worktree>> = HashMap::new();
        let now = now_ms();
        let running: HashMap<String, String> = self
            .execs
            .lock()
            .values()
            .filter(|e| !e.exited)
            .filter_map(|e| e.session_id.clone().map(|s| (s, e.id.clone())))
            .collect();

        let mut out = Vec::with_capacity(metas.len());
        let mut link_writes = Vec::new();
        for m in metas {
            let cwd = m.cwd.clone().unwrap_or_default();
            // 대화 도중 다른 폴더/워크트리로 옮겼으면 "지금 일하는 곳"은 마지막 cwd 다(재개는 첫 cwd 에서).
            let mut work_cwd = m.last_cwd.clone().filter(|c| Path::new(c).is_dir()).unwrap_or_else(|| cwd.clone());
            let mut loc = if Path::new(&work_cwd).is_dir() { self.locate_cached(&work_cwd) } else { None };
            // 상위 폴더(저장소 아님)에서 시작해 cd 로 저장소 안에서 일한 세션: 마지막 기록이 다시 상위 폴더여도
            // 최근에 일한 폴더 중 저장소 안인 곳에 붙인다(재개는 여전히 첫 cwd 에서).
            let mut via_recent = false;
            if loc.is_none() {
                for (c, _) in m.recent_cwds.iter().filter(|(c, _)| Path::new(c).is_dir()) {
                    if let Some(l) = self.locate_cached(c) {
                        work_cwd = c.clone();
                        loc = Some(l);
                        via_recent = true;
                        break;
                    }
                }
            }
            // 최근에 일한 다른 워크트리들: 그 워크트리 목록에도 보여 준다. 잠깐 들여다본 곳은 빼려고
            // 워크트리별(하위 폴더 합산) 기록 수가 최근 기록의 10% 이상이고 5줄 이상인 곳만.
            let total: u32 = m.recent_cwds.iter().map(|(_, n)| n).sum();
            let mut per_wt: Vec<(String, u32)> = Vec::new();
            for (c, n) in m.recent_cwds.iter().filter(|(c, _)| Path::new(c).is_dir()) {
                let Some(l) = self.locate_cached(c) else { continue };
                if Some(&l.toplevel) == loc.as_ref().map(|x| &x.toplevel) {
                    continue;
                }
                match per_wt.iter_mut().find(|(w, _)| *w == l.toplevel) {
                    Some((_, k)) => *k += n,
                    None => per_wt.push((l.toplevel.clone(), *n)),
                }
            }
            let other_worktrees: Vec<String> = per_wt.into_iter().filter(|(_, n)| *n >= 5 && *n * 10 >= total).map(|(w, _)| w).collect();
            let cwd_exists = Path::new(&work_cwd).is_dir() && Path::new(&cwd).is_dir();
            let start_loc = if work_cwd != cwd && Path::new(&cwd).is_dir() { self.locate_cached(&cwd) } else { loc.clone() };
            let cwd_moved = start_loc.as_ref().map(|l| &l.toplevel) != loc.as_ref().map(|l| &l.toplevel);
            let (repo_id, worktree_path) = match &loc {
                Some(l) => (Some(l.common_dir.clone()), Some(l.toplevel.clone())),
                // 폴더가 사라졌을 때만 예전에 저장해 둔 연결을 쓴다. 폴더가 있는데 저장소가 아니면 "Git 아님".
                None if !Path::new(&work_cwd).is_dir() => {
                    let l = links.get(&m.id);
                    (l.and_then(|l| l.repo_id.clone()), l.and_then(|l| l.worktree_path.clone()))
                }
                None => (None, None),
            };
            if let Some(l) = &loc
                && !repos.contains_key(&l.common_dir)
            {
                let main = git::worktrees(Path::new(&l.toplevel)).ok().and_then(|w| w.into_iter().find(|w| w.is_main)).map(|w| w.path);
                let main = main.unwrap_or_else(|| l.toplevel.clone());
                let _ = self.db.upsert_repo(&l.common_dir, &main, &repo_name(&main), false);
            }
            // 연결 정보 저장 (재시작 후 복원, 워크트리가 지워진 뒤에도 표시). 바뀐 것만 모아 한 번에 쓴다.
            let prev = links.get(&m.id);
            let changed = prev.is_none_or(|p| {
                (repo_id.is_some() && p.repo_id != repo_id) || (worktree_path.is_some() && p.worktree_path != worktree_path) || p.cwd != cwd
            });
            if changed {
                link_writes.push(SessionLink {
                    session_id: m.id.clone(),
                    repo_id: repo_id.clone(),
                    worktree_path: worktree_path.clone(),
                    cwd: cwd.clone(),
                    start_branch: m.start_branch.clone(),
                    first_seen_at: now,
                    last_seen_at: now,
                });
            }

            // 워크트리의 현재 브랜치(실시간). git 을 띄우지 않고 HEAD 파일을 직접 읽는다(목록 갱신이 잦아서).
            let (mut cb, mut ch, mut cd) = (None, None, false);
            if let Some(l) = &loc {
                if let Some((b, h, d)) = git::read_head(Path::new(&l.git_dir), Path::new(&l.common_dir)) {
                    cb = b;
                    ch = h;
                    cd = d;
                }
            }
            let repo_name = repo_id.as_ref().and_then(|id| repos.get(id).map(|r| r.name.clone())).or_else(|| {
                loc.as_ref().map(|l| {
                    let p = wt_cache
                        .entry(l.common_dir.clone())
                        .or_insert_with(|| git::worktrees(Path::new(&l.toplevel)).unwrap_or_default())
                        .iter()
                        .find(|w| w.is_main)
                        .map(|w| w.path.clone());
                    repo_name(&p.unwrap_or(l.toplevel.clone()))
                })
            });
            let mut m = m;
            if via_recent {
                // 마지막 기록은 저장소 밖(상위 폴더)이라 브랜치가 "HEAD" 자리표시로 적혀 있다.
                if m.last_branch.as_deref() == Some("HEAD") {
                    m.last_branch = None;
                }
                if start_loc.is_none() && m.start_branch.as_deref() == Some("HEAD") {
                    m.start_branch = None;
                }
            }
            if worktree_path.is_none() {
                // 저장소가 아닌 폴더에서 Claude 는 gitBranch 를 "HEAD" 로 적는다. 브랜치로 보이지 않게 지운다.
                for b in [&mut m.start_branch, &mut m.last_branch] {
                    if b.as_deref() == Some("HEAD") {
                        *b = None;
                    }
                }
            }
            let worktree_alias = worktree_path.as_deref().and_then(|wt| path_alias(&work_cwd, wt));
            out.push(LinkedSession {
                running_exec_id: running.get(&m.id).cloned(),
                meta: m,
                repo_id,
                repo_name,
                worktree_path,
                worktree_alias,
                cwd_moved,
                cwd_exists,
                current_branch: cb,
                current_head: ch,
                current_detached: cd,
                other_worktrees,
            });
        }
        {
            let mut sw = self.session_worktrees.lock();
            for s in &out {
                if let (Some(w), true) = (&s.worktree_path, s.cwd_exists) {
                    sw.insert(w.clone());
                }
            }
        }
        if let Err(e) = self.db.upsert_links(&link_writes) {
            eprintln!("[sessions] 연결 정보 저장 실패: {e:#}");
        }
        self.link_pending_codex_execs();
        Ok(out)
    }

    pub fn find_session(&self, id: &str) -> Option<SessionMeta> {
        if let Some(m) = self.last_sessions.lock().iter().find(|m| m.id == id) {
            return Some(m.clone());
        }
        self.scan_sessions().into_iter().find(|m| m.id == id)
    }

    pub fn transcript(&self, id: &str) -> Result<Transcript> {
        let meta = self.find_session(id).ok_or_else(|| anyhow!(tr!("세션을 찾을 수 없습니다: {id}", "Session not found: {id}")))?;
        let path = PathBuf::from(&meta.source_path);
        match meta.agent.as_str() {
            "claude" => sessions::claude_transcript(&path),
            "codex" => sessions::codex_transcript(&path),
            other => bail!(tr!("알 수 없는 에이전트: {other}", "Unknown agent: {other}")),
        }
    }

    // ───────────── Git ─────────────

    pub fn graph(&self, worktree: &str, limit: usize) -> Result<GraphData> {
        let p = Path::new(worktree);
        let worktrees = git::worktrees(p)?;
        let heads: Vec<String> = worktrees.iter().filter_map(|w| w.head.clone()).collect();
        let commits = git::log_for_graph(p, &heads, limit + 1)?;
        let truncated = commits.len() > limit;
        let commits = &commits[..commits.len().min(limit)];
        let me = worktrees.iter().find(|w| w.path == worktree);
        Ok(GraphData {
            rows: graph::layout(commits),
            refs: git::refs(p)?,
            head: me.and_then(|w| w.head.clone()),
            head_branch: me.and_then(|w| w.branch.clone()),
            worktrees,
            limit,
            truncated,
        })
    }

    pub fn watch_targets(&self, worktrees: &[String]) -> Vec<WatchTarget> {
        let mut out = Vec::new();
        for w in worktrees {
            if let Some(loc) = self.locate_cached(w) {
                out.push(WatchTarget {
                    worktree: PathBuf::from(&loc.toplevel),
                    git_dir: PathBuf::from(&loc.git_dir),
                    common_dir: PathBuf::from(&loc.common_dir),
                });
            }
        }
        out.sort_by(|a, b| a.worktree.cmp(&b.worktree));
        out.dedup();
        out
    }

    // ───────────── 실행 ─────────────

    pub fn exec_list(&self) -> Vec<ExecInfo> {
        let mut v: Vec<ExecInfo> = self.execs.lock().values().cloned().collect();
        v.sort_by_key(|a| a.started_at);
        v
    }

    pub fn start(self: &Arc<Self>, req: StartRequest) -> Result<ExecInfo> {
        let _open = self.open_lock.lock();
        let (program, mut args, cwd, session_id): (String, Vec<String>, String, Option<String>) = match (req.agent.as_str(), req.mode.as_str()) {
            (agent @ ("claude" | "codex"), "resume") => {
                let sid = req.session_id.clone().ok_or_else(|| anyhow!(tr!("재개할 세션을 고르세요", "Choose a session to resume")))?;
                let meta = self.find_session(&sid).ok_or_else(|| anyhow!(tr!("세션을 찾을 수 없습니다: {sid}", "Session not found: {sid}")))?;
                if meta.agent != agent {
                    bail!(tr!("세션 종류가 맞지 않습니다", "Session type does not match"));
                }
                if !sessions::is_safe_session_id(&meta.external_id) {
                    bail!(tr!("세션 id 형식이 올바르지 않습니다: {}", "Invalid session ID format: {}", meta.external_id));
                }
                let cwd = meta.cwd.clone().ok_or_else(|| anyhow!(tr!("세션에 작업 폴더 기록이 없습니다", "The session has no recorded working folder")))?;
                if !Path::new(&cwd).is_dir() {
                    bail!(tr!("세션이 작업하던 폴더가 없습니다: {cwd}\n워크트리가 삭제되었을 수 있습니다.", "The session's working folder no longer exists: {cwd}\nThe worktree may have been deleted."));
                }
                for dead in self.chats.dead_for_session(&sid) {
                    self.chats.close(&dead);
                }
                self.ensure_not_open(&sid, req.force)?;
                let args = if agent == "claude" {
                    vec!["--resume".to_string(), meta.external_id.clone()]
                } else {
                    vec!["resume".to_string(), meta.external_id.clone(), "-C".to_string(), cwd.clone()]
                };
                (agent.to_string(), args, cwd, Some(sid))
            }
            (agent @ ("claude" | "codex"), "new") => {
                let cwd = req.cwd.clone().ok_or_else(|| anyhow!(tr!("작업 폴더를 고르세요", "Choose a working folder")))?;
                if !Path::new(&cwd).is_dir() {
                    bail!(tr!("폴더가 없습니다: {cwd}", "Folder not found: {cwd}"));
                }
                if agent == "claude" {
                    // 세션 id 를 미리 정해 실행과 세션을 즉시 연결한다.
                    let id = uuid::Uuid::new_v4().to_string();
                    (agent.to_string(), vec!["--session-id".to_string(), id.clone()], cwd, Some(format!("claude:{id}")))
                } else {
                    let cwd2 = cwd.clone();
                    (agent.to_string(), vec!["-C".to_string(), cwd2], cwd, None)
                }
            }
            _ => bail!(tr!("지원하지 않는 실행 요청입니다", "Unsupported launch request")),
        };
        // 첫 지시: `--` 뒤에 두어 '-' 로 시작해도 옵션으로 해석되지 않게 한다(셸을 거치지 않으므로 따옴표 문제 없음).
        if req.mode == "new" {
            if let Some(p) = req.prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                args.push("--".into());
                args.push(p.to_string());
            }
        }
        // 테스트에서 실제 CLI 대신 가짜 프로그램을 쓸 수 있게 한다.
        #[cfg(debug_assertions)]
        let program = std::env::var(format!("AITERM_{}_BIN", program.to_uppercase())).unwrap_or(program);
        let loc = self.locate_cached(&cwd);
        let (branch, head) = match &loc {
            Some(l) => {
                let w = git::worktrees(Path::new(&l.toplevel)).ok().and_then(|ws| ws.into_iter().find(|w| w.path == l.toplevel));
                (w.as_ref().and_then(|w| w.branch.clone()), w.and_then(|w| w.head))
            }
            None => (None, None),
        };
        let id = uuid::Uuid::new_v4().to_string();
        let started_at = now_ms();
        let mut argv = vec![program.clone()];
        argv.append(&mut args.clone());
        let row = ExecutionRow {
            id: id.clone(),
            session_id: session_id.clone(),
            agent: req.agent.clone(),
            kind: req.mode.clone(),
            argv: argv.clone(),
            cwd: cwd.clone(),
            worktree_path: loc.as_ref().map(|l| l.toplevel.clone()),
            branch_at_start: branch.clone(),
            head_at_start: head.clone(),
            started_at,
            ended_at: None,
            exit_code: None,
        };
        let exec = self.pty.spawn(
            id.clone(),
            SpawnSpec { program, args: std::mem::take(&mut args), cwd: cwd.clone(), cols: req.cols, rows: req.rows, extra_env: vec![] },
            self.on_exec_exit(),
        )?;
        self.db.insert_execution(&row)?;
        let info = ExecInfo {
            id: id.clone(),
            session_id,
            agent: req.agent,
            kind: req.mode,
            cwd,
            worktree_path: row.worktree_path.clone(),
            branch_at_start: branch,
            head_at_start: head,
            started_at,
            pid: exec.pid,
            exited: false,
            exit_code: None,
        };
        self.execs.lock().insert(id, info.clone());
        Ok(info)
    }

    /// 실행이 끝났을 때: 기록에 남기고 화면에 알린다.
    fn on_exec_exit(self: &Arc<Self>) -> impl FnOnce(&str, Option<i32>) + Send + 'static {
        let weak = Arc::downgrade(self);
        move |eid, code| {
            if let Some(core) = weak.upgrade() {
                let _ = core.db.finish_execution(eid, code);
                if let Some(e) = core.execs.lock().get_mut(eid) {
                    e.exited = true;
                    e.exit_code = code;
                }
                core.emit("exec-exit", json!({ "id": eid, "code": code }));
            }
        }
    }

    /// 이전 버전 앱이 업데이트하며 넘겨준 실행을 같은 실행 id·기록으로 이어서 연다.
    pub fn adopt_exec(self: &Arc<Self>, info: ExecInfo, master: std::os::fd::OwnedFd, buffer: Vec<u8>) -> Result<()> {
        self.pty.adopt(info.id.clone(), info.pid, master, buffer, self.on_exec_exit())?;
        // 앱을 열 때 '끝나지 않은 실행' 을 비정상 종료로 보고 끝냈으니 되돌린다
        let _ = self.db.reopen_execution(&info.id);
        self.execs.lock().insert(info.id.clone(), ExecInfo { exited: false, exit_code: None, ..info });
        Ok(())
    }

    /// 같은 대화를 두 곳에서 동시에 쓰면 기록이 꼬인다. 앱 안의 터미널·채팅은 막고,
    /// 외부에서 실행 중이면 사용자가 확인(force)한 경우에만 연다.
    pub fn ensure_not_open(&self, session_id: &str, force: bool) -> Result<()> {
        if let Some(e) = self.execs.lock().values().find(|e| e.session_id.as_deref() == Some(session_id) && !e.exited) {
            bail!(tr!("이 세션은 이미 앱의 터미널에서 실행 중입니다 (실행 {})", "This session is already running in the app's terminal (run {})", e.id));
        }
        if self.chats.find_by_session(session_id).is_some() {
            bail!(tr!("이 세션은 이미 앱의 채팅으로 열려 있습니다", "This session is already open as a chat in the app"));
        }
        if !force {
            // 5초 주기 결과는 오래되었을 수 있으니 열기 직전에 다시 훑는다(libproc, 수 ms).
            self.refresh_live();
            if let Some(r) = self.live.lock().iter().find(|r| r.session_id == session_id && !r.owned_by_app) {
                bail!("EXTERNAL_RUNNING:{}:{}", r.pid, r.client);
            }
        }
        Ok(())
    }

    // ───────────── 실행 중 감지 ─────────────

    /// 앱이 띄운 프로세스 pid (터미널 실행 + 채팅)
    pub fn app_pids(&self) -> std::collections::HashSet<u32> {
        let mut set: std::collections::HashSet<u32> = self.exec_list().into_iter().filter(|e| !e.exited).filter_map(|e| e.pid).collect();
        set.extend(self.chats.list().into_iter().filter_map(|c| c.pid));
        set.extend(self.chats.closing_pids());
        set
    }

    /// 다시 훑어서 바뀌었으면 true
    pub fn refresh_live(&self) -> bool {
        let runs = crate::procs::scan(&self.app_pids());
        let mut cur = self.live.lock();
        if *cur == runs {
            return false;
        }
        *cur = runs;
        true
    }

    pub fn live_runs(&self) -> Vec<LiveRun> {
        self.live.lock().clone()
    }

    // ───────────── 채팅 ─────────────

    /// 세션을 채팅으로 열거나(resume), 새 채팅을 시작한다.
    pub fn chat_start(&self, agent: &str, session_id: Option<&str>, cwd: Option<&str>, mode: &str, force: bool) -> Result<ChatInfo> {
        let events = self.events.clone();
        let on_change: Arc<dyn Fn(&ChatInfo) + Send + Sync> = Arc::new(move |info| events("chat-changed", json!(info)));
        let _open = self.open_lock.lock();
        let (resume_id, cwd) = match session_id {
            Some(sid) => {
                if let Some(c) = self.chats.find_by_session(sid) {
                    return Ok(c.info()); // 이미 열린 채팅
                }
                // 프로세스가 끝난 채 남은 채팅은 정리하고 새로 연다.
                for dead in self.chats.dead_for_session(sid) {
                    self.chats.close(&dead);
                }
                self.ensure_not_open(sid, force)?;
                let meta = self.find_session(sid).ok_or_else(|| anyhow!(tr!("세션을 찾을 수 없습니다: {sid}", "Session not found: {sid}")))?;
                if meta.agent != agent {
                    bail!(tr!("세션 종류가 맞지 않습니다", "Session type does not match"));
                }
                let cwd = meta.cwd.clone().ok_or_else(|| anyhow!(tr!("세션에 작업 폴더 기록이 없습니다", "The session has no recorded working folder")))?;
                (Some(meta.external_id), cwd)
            }
            None => (None, cwd.ok_or_else(|| anyhow!(tr!("작업 폴더를 고르세요", "Choose a working folder")))?.to_string()),
        };
        let info = self.chats.start(StartChat { agent: agent.to_string(), resume_id, cwd, mode: mode.to_string() }, on_change)?;
        (self.events)("chat-changed", json!(info));
        Ok(info)
    }

    /// Codex 새 실행은 세션 id 를 미리 알 수 없다. 같은 cwd 에서 실행 이후 생긴 스레드와 연결한다.
    pub fn link_pending_codex_execs(&self) {
        /// 실행 시작 뒤 이 시간 안에 생긴 스레드만 그 실행의 것으로 본다.
        const WINDOW_MS: i64 = 10 * 60_000;
        let sessions = self.last_sessions.lock().clone();
        let mut execs = self.execs.lock();
        let mut taken: std::collections::HashSet<String> = execs.values().filter_map(|e| e.session_id.clone()).collect();
        // 실행 중인 것만, 먼저 시작한 실행부터 (HashMap 순서에 기대지 않는다)
        let mut pending: Vec<&mut ExecInfo> =
            execs.values_mut().filter(|e| e.agent == "codex" && e.session_id.is_none() && !e.exited).collect();
        pending.sort_by_key(|e| e.started_at);
        for e in pending {
            let cwd_canon = std::fs::canonicalize(&e.cwd).ok();
            let cand = sessions
                .iter()
                .filter(|s| s.agent == "codex" && !taken.contains(&s.id))
                .filter(|s| {
                    let sc = s.cwd.as_deref().and_then(|c| std::fs::canonicalize(c).ok());
                    sc.is_some() && sc == cwd_canon
                })
                .filter(|s| s.created_at >= e.started_at - 5_000 && s.created_at <= e.started_at + WINDOW_MS)
                .min_by_key(|s| s.created_at);
            if let Some(s) = cand {
                taken.insert(s.id.clone());
                e.session_id = Some(s.id.clone());
                let _ = self.db.set_execution_session(&e.id, &s.id);
                (self.events)("exec-linked", json!({ "execId": e.id, "sessionId": s.id }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! 실제 git 저장소와 가짜 HOME 을 써서 세션 ↔ 워크트리 연결을 검증하는 통합 테스트.
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// 메인(main) + 링크 워크트리(feature) 저장소
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let main = root.join("repo");
        std::fs::create_dir(&main).unwrap();
        sh(&main, &["init", "-q", "-b", "main"]);
        std::fs::write(main.join("a.txt"), "1\n").unwrap();
        sh(&main, &["add", "."]);
        sh(&main, &["commit", "-qm", "first"]);
        let wt = root.join("repo-feature");
        sh(&main, &["worktree", "add", "-q", "-b", "feature", wt.to_str().unwrap()]);
        std::fs::write(wt.join("b.txt"), "2\n").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-qm", "feature work"]);
        (tmp, main, wt)
    }

    fn write_claude(home: &Path, id: &str, cwd: &Path, branches: (&str, &str)) {
        let dir = home.join(".claude/projects/x");
        std::fs::create_dir_all(&dir).unwrap();
        let c = cwd.to_str().unwrap();
        let lines = [
            json!({"type":"user","cwd":c,"gitBranch":branches.0,"timestamp":"2026-10-01T00:00:00Z","message":{"content":"시작"}}),
            json!({"type":"assistant","cwd":c,"gitBranch":branches.1,"timestamp":"2026-10-01T00:01:00Z","message":{"content":[{"type":"text","text":"ok"}]}}),
        ];
        std::fs::write(dir.join(format!("{id}.jsonl")), lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    }

    fn write_codex(home: &Path, id: &str, cwd: &Path, branch: &str) {
        let dir = home.join(".codex/sessions/2026/10/01");
        std::fs::create_dir_all(&dir).unwrap();
        let l = json!({"timestamp":"2026-10-01T00:00:00Z","type":"session_meta","payload":{"id":id,"cwd":cwd,"source":"cli","timestamp":"2026-10-01T00:00:00Z","git":{"branch":branch}}});
        let data = format!("{l}\n");
        std::fs::write(dir.join(format!("rollout-2026-10-01T00-00-00-{id}.jsonl.zst")), zstd::encode_all(data.as_bytes(), 3).unwrap()).unwrap();
    }

    use crate::env::TEST_ENV_LOCK as HOME_LOCK;

    #[test]
    fn sessions_link_to_their_own_worktree_and_branches_stay_separate() {
        let _g = HOME_LOCK.lock();
        let (tmp, main, wt) = fixture();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: HOME_LOCK 으로 이 테스트들끼리 직렬화한다.
        unsafe { std::env::set_var("AITERM_HOME", &home) };

        // Claude 세션: feature 워크트리 하위 폴더에서 시작, 기록상 feature 브랜치
        std::fs::create_dir(wt.join("sub")).unwrap();
        write_claude(&home, "c1", &wt.join("sub"), ("feature", "feature"));
        // Codex 세션: 메인 워크트리
        write_codex(&home, "x1", &main, "main");

        let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
        let list = core.list_sessions().unwrap();
        let c = list.iter().find(|s| s.meta.id == "claude:c1").unwrap();
        let x = list.iter().find(|s| s.meta.id == "codex:x1").unwrap();

        // 같은 저장소(common dir), 다른 워크트리
        assert_eq!(c.repo_id, x.repo_id);
        assert_eq!(c.worktree_path.as_deref(), Some(wt.to_str().unwrap()));
        assert_eq!(x.worktree_path.as_deref(), Some(main.to_str().unwrap()));
        assert_eq!(c.current_branch.as_deref(), Some("feature"));
        assert_eq!(x.current_branch.as_deref(), Some("main"));
        assert_eq!(c.repo_name.as_deref(), Some("repo"));

        // 외부 터미널에서 feature 워크트리의 브랜치를 바꾼다 → 현재 값만 바뀌고 기록 값은 그대로
        sh(&wt, &["switch", "-q", "-c", "other"]);
        let list = core.list_sessions().unwrap();
        let c = list.iter().find(|s| s.meta.id == "claude:c1").unwrap();
        assert_eq!(c.meta.start_branch.as_deref(), Some("feature"));
        assert_eq!(c.current_branch.as_deref(), Some("other"));

        // 조회만으로 어떤 워크트리의 HEAD 도 바뀌지 않았다
        assert_eq!(sh(&main, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert_eq!(sh(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]), "other");

        // 저장소가 자동 발견되어 저장되었다(pinned 아님)
        let repos = core.list_repos().unwrap();
        assert_eq!(repos.len(), 1);
        assert!(!repos[0].row.pinned);
        assert_eq!(repos[0].worktrees.len(), 2);

        // 워크트리를 지워도 저장된 연결로 어느 워크트리였는지 보여 준다
        sh(&main, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
        let list = core.list_sessions().unwrap();
        let c = list.iter().find(|s| s.meta.id == "claude:c1").unwrap();
        assert!(!c.cwd_exists);
        assert_eq!(c.worktree_path.as_deref(), Some(wt.to_str().unwrap()));
        assert!(c.current_branch.is_none());
        unsafe { std::env::remove_var("AITERM_HOME") };
    }

    #[test]
    fn graph_matches_git_cli() {
        let _g = HOME_LOCK.lock();
        let (_tmp, main, wt) = fixture();
        let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
        let g = core.graph(main.to_str().unwrap(), 100).unwrap();
        let cli: Vec<String> = sh(&main, &["log", "--topo-order", "--format=%H", "--branches", "--remotes", "--tags"]).lines().map(str::to_string).collect();
        let ours: Vec<String> = g.rows.iter().map(|r| r.sha.clone()).collect();
        assert_eq!(ours, cli);
        assert_eq!(g.head_branch.as_deref(), Some("main"));
        assert_eq!(g.head.as_deref(), Some(sh(&main, &["rev-parse", "HEAD"]).as_str()));
        let gw = core.graph(wt.to_str().unwrap(), 100).unwrap();
        assert_eq!(gw.head_branch.as_deref(), Some("feature"));
        assert_eq!(gw.worktrees.len(), 2);
        // detached HEAD 커밋도 그래프에 나온다
        std::fs::write(wt.join("c.txt"), "3").unwrap();
        sh(&wt, &["switch", "-q", "--detach"]);
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-qm", "detached work"]);
        let detached = sh(&wt, &["rev-parse", "HEAD"]);
        let g = core.graph(main.to_str().unwrap(), 100).unwrap();
        assert!(g.rows.iter().any(|r| r.sha == detached));
    }

    #[test]
    fn status_and_diff_match_real_changes() {
        let _g = HOME_LOCK.lock();
        let (_tmp, main, _wt) = fixture();
        std::fs::write(main.join("a.txt"), "1\nchanged\n").unwrap();
        std::fs::write(main.join("새 파일.txt"), "new\n").unwrap();
        std::fs::remove_file(main.join("a.txt")).ok();
        std::fs::write(main.join("a.txt"), "1\nchanged\n").unwrap();
        let st = git::status(&main).unwrap();
        let kinds: HashMap<_, _> = st.entries.iter().map(|e| (e.path.as_str(), e.kind.as_str())).collect();
        assert_eq!(kinds.get("a.txt"), Some(&"modified"));
        assert_eq!(kinds.get("새 파일.txt"), Some(&"untracked"));
        let d = git::diff_worktree_file(&main, "a.txt").unwrap();
        assert_eq!((d[0].additions, d[0].deletions), (1, 0));
        let d = git::diff_worktree_file(&main, "새 파일.txt").unwrap();
        assert_eq!(d[0].additions, 1);
        // diff 조회가 index 를 바꾸지 않는다
        assert_eq!(sh(&main, &["diff", "--cached", "--name-only"]), "");
    }

    #[test]
    fn checkout_refuses_branch_used_by_other_worktree() {
        let _g = HOME_LOCK.lock();
        let (_tmp, main, _wt) = fixture();
        let err = git::checkout(&main, "feature", "branch").unwrap_err();
        assert!(err.to_string().contains("feature"), "{err}");
        assert_eq!(sh(&main, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    }

    #[test]
    fn commit_only_selected_paths() {
        let _g = HOME_LOCK.lock();
        let (_tmp, main, _wt) = fixture();
        std::fs::write(main.join("x.txt"), "x").unwrap();
        std::fs::write(main.join("y.txt"), "y").unwrap();
        git::commit(&main, &["x.txt".into()], "add x\n\n본문").unwrap();
        assert_eq!(sh(&main, &["log", "-1", "--format=%s"]), "add x");
        let st = git::status(&main).unwrap();
        assert_eq!(st.entries.len(), 1);
        assert_eq!(st.entries[0].path, "y.txt");
    }

    #[test]
    fn resume_uses_recorded_cwd_and_codex_new_links_later() {
        let _g = HOME_LOCK.lock();
        let (tmp, main, wt) = fixture();
        let home = tmp.path().join("home2");
        std::fs::create_dir_all(&home).unwrap();
        unsafe { std::env::set_var("AITERM_HOME", &home) };
        write_claude(&home, "c9", &wt, ("feature", "feature"));
        // 실제 claude 대신 인자와 작업 폴더를 출력하는 가짜 프로그램
        let fake = tmp.path().join("fake.sh");
        // 실제 CLI 처럼 잠시 살아 있다(종료된 실행은 새 스레드와 연결하지 않으므로).
        std::fs::write(&fake, "#!/bin/sh\necho \"ARGS:$*\"\necho \"PWD:$(pwd -P)\"\nsleep 5\n").unwrap();
        std::os::unix::fs::PermissionsExt::set_mode(&mut std::fs::metadata(&fake).unwrap().permissions(), 0o755);
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        unsafe {
            std::env::set_var("AITERM_CLAUDE_BIN", &fake);
            std::env::set_var("AITERM_CODEX_BIN", &fake);
        }

        let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
        core.list_sessions().unwrap();
        let info = core
            .start(StartRequest { agent: "claude".into(), mode: "resume".into(), session_id: Some("claude:c9".into()), cwd: None, cols: 80, rows: 24, force: false, prompt: None })
            .unwrap();
        assert_eq!(info.branch_at_start.as_deref(), Some("feature"));
        assert_eq!(info.worktree_path.as_deref(), Some(wt.to_str().unwrap()));
        // 부하가 클 때도 흔들리지 않게 고정 대기 대신 출력이 나올 때까지 최대 5초 기다린다.
        let mut out = String::new();
        for _ in 0..100 {
            out = core.pty.output_text(&info.id).unwrap();
            if out.contains("PWD:") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(out.contains("ARGS:--resume c9"), "{out}");
        assert!(out.contains(&format!("PWD:{}", wt.display())), "{out}");

        // 새 세션의 첫 지시는 `--` 뒤 인자로 넘어간다
        let first = core
            .start(StartRequest { agent: "claude".into(), mode: "new".into(), session_id: None, cwd: Some(main.to_string_lossy().into()), cols: 80, rows: 24, force: false, prompt: Some("-v 로 시작하는 지시".into()) })
            .unwrap();
        let mut out = String::new();
        for _ in 0..100 {
            out = core.pty.output_text(&first.id).unwrap();
            if out.contains("PWD:") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(out.contains("-- -v 로 시작하는 지시"), "{out}");

        // Codex 새 실행: 시작 후 같은 cwd 에 생긴 스레드와 연결된다
        let info = core
            .start(StartRequest { agent: "codex".into(), mode: "new".into(), session_id: None, cwd: Some(main.to_string_lossy().into()), cols: 80, rows: 24, force: false, prompt: None })
            .unwrap();
        assert!(info.session_id.is_none());
        write_codex(&home, "fresh", &main, "main");
        // 기록 시각을 실행 이후로 맞춘다
        let dir = home.join(".codex/sessions/2026/10/01");
        let ts = chrono_like_iso(now_ms() + 1000);
        let l = json!({"timestamp":ts,"type":"session_meta","payload":{"id":"fresh","cwd":main,"source":"cli","timestamp":ts,"git":{"branch":"main"}}});
        std::fs::write(dir.join("rollout-2026-10-01T00-00-00-fresh.jsonl.zst"), zstd::encode_all(format!("{l}\n").as_bytes(), 3).unwrap()).unwrap();
        core.list_sessions().unwrap();
        let e = core.exec_list().into_iter().find(|e| e.id == info.id).unwrap();
        assert_eq!(e.session_id.as_deref(), Some("codex:fresh"));

        // 같은 폴더에서 두 번째 새 실행: 이미 연결된 스레드를 다시 가져가지 않는다.
        let second = core
            .start(StartRequest { agent: "codex".into(), mode: "new".into(), session_id: None, cwd: Some(main.to_string_lossy().into()), cols: 80, rows: 24, force: false, prompt: None })
            .unwrap();
        core.list_sessions().unwrap();
        let e2 = core.exec_list().into_iter().find(|e| e.id == second.id).unwrap();
        assert_eq!(e2.session_id, None, "must not steal the first exec's thread");
        // 오래된 외부 세션(실행 시작보다 한참 전)과도 연결되지 않는다: x1 같은 2026-10-01 세션
        let ts2 = chrono_like_iso(now_ms() + 2000);
        let l2 = json!({"timestamp":ts2,"type":"session_meta","payload":{"id":"fresh2","cwd":main,"source":"cli","timestamp":ts2,"git":{"branch":"main"}}});
        std::fs::write(dir.join("rollout-2026-10-01T00-00-01-fresh2.jsonl.zst"), zstd::encode_all(format!("{l2}\n").as_bytes(), 3).unwrap()).unwrap();
        core.list_sessions().unwrap();
        let e2 = core.exec_list().into_iter().find(|e| e.id == second.id).unwrap();
        assert_eq!(e2.session_id.as_deref(), Some("codex:fresh2"));
        unsafe {
            std::env::remove_var("AITERM_HOME");
            std::env::remove_var("AITERM_CLAUDE_BIN");
            std::env::remove_var("AITERM_CODEX_BIN");
        }
    }

    #[test]
    fn alias_for_symlinked_tmp_and_moved_cwd() {
        let _g = HOME_LOCK.lock();
        // macOS 의 /tmp 는 /private/tmp 로 가는 심볼릭 링크
        let d = tempfile::Builder::new().prefix("aiterm-alias").tempdir_in("/tmp").unwrap();
        let raw = format!("/tmp/{}", d.path().file_name().unwrap().to_string_lossy());
        let canon = std::fs::canonicalize(&raw).unwrap().to_string_lossy().into_owned();
        if canon != raw {
            std::fs::create_dir(format!("{raw}/sub")).unwrap();
            assert_eq!(path_alias(&format!("{raw}/sub"), &canon).as_deref(), Some(raw.as_str()));
        }
        assert_eq!(path_alias(&canon, &canon), None);

        // 대화 도중 메인 → 링크 워크트리로 옮겨 간 Claude 세션
        let (tmp, main, wt) = fixture();
        let home = tmp.path().join("home3");
        unsafe { std::env::set_var("AITERM_HOME", &home) };
        let dir = home.join(".claude/projects/x");
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            json!({"type":"user","cwd":main,"gitBranch":"main","timestamp":"2026-10-01T00:00:00Z","message":{"content":"시작"}}),
            json!({"type":"assistant","cwd":wt,"gitBranch":"feature","timestamp":"2026-10-01T00:01:00Z","message":{"content":[{"type":"text","text":"ok"}]}}),
        ];
        std::fs::write(dir.join("mv1.jsonl"), lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
        let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
        let s = core.list_sessions().unwrap().into_iter().find(|s| s.meta.id == "claude:mv1").unwrap();
        assert_eq!(s.worktree_path.as_deref(), Some(wt.to_str().unwrap()), "links to where it works now");
        assert!(s.cwd_moved);
        assert_eq!(s.meta.cwd.as_deref(), Some(main.to_str().unwrap()), "resume still uses the first cwd");
        unsafe { std::env::remove_var("AITERM_HOME") };
    }

    #[test]
    fn session_now_outside_any_repo_is_not_shown_with_old_link() {
        let _g = HOME_LOCK.lock();
        let (tmp, main, _wt) = fixture();
        let home = tmp.path().join("home4");
        unsafe { std::env::set_var("AITERM_HOME", &home) };
        let outside = tmp.path().join("plain");
        std::fs::create_dir_all(&outside).unwrap();
        let dir = home.join(".claude/projects/x");
        std::fs::create_dir_all(&dir).unwrap();
        let write = |last: &Path| {
            let lines = [
                json!({"type":"user","cwd":outside,"gitBranch":"HEAD","timestamp":"2026-10-01T00:00:00Z","message":{"content":"시작"}}),
                json!({"type":"assistant","cwd":last,"gitBranch":"HEAD","timestamp":"2026-10-01T00:01:00Z","message":{"content":[{"type":"text","text":"ok"}]}}),
            ];
            std::fs::write(dir.join("out1.jsonl"), lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
        };
        let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
        write(&main); // 마지막에 저장소 안 → 연결이 저장된다
        let s = core.list_sessions().unwrap().into_iter().find(|s| s.meta.id == "claude:out1").unwrap();
        assert!(s.worktree_path.is_some());
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&outside); // 다시 저장소 밖으로
        let s = core.list_sessions().unwrap().into_iter().find(|s| s.meta.id == "claude:out1").unwrap();
        assert!(s.worktree_path.is_none(), "folder exists but is not a repo → no stale link");
        assert!(s.meta.start_branch.is_none() && s.meta.last_branch.is_none(), "HEAD placeholder cleared");
        unsafe { std::env::remove_var("AITERM_HOME") };
    }

    #[test]
    fn session_started_above_repo_links_to_where_it_worked() {
        // 상위 폴더(저장소 아님)에서 claude 를 열고 cd 로 저장소 안에서 일한 뒤, 마지막 기록이 다시 상위 폴더인 세션
        let _g = HOME_LOCK.lock();
        let (tmp, main, wt) = fixture();
        let home = tmp.path().join("home5");
        unsafe { std::env::set_var("AITERM_HOME", &home) };
        let parent = tmp.path().join("apps");
        std::fs::create_dir_all(&parent).unwrap();
        let dir = home.join(".claude/projects/x");
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            json!({"type":"user","cwd":parent,"gitBranch":"HEAD","timestamp":"2026-10-01T00:00:00Z","message":{"content":"시작"}}),
            json!({"type":"assistant","cwd":wt,"gitBranch":"feature","timestamp":"2026-10-01T00:01:00Z","message":{"content":[{"type":"text","text":"a"}]}}),
            json!({"type":"assistant","cwd":wt,"gitBranch":"feature","timestamp":"2026-10-01T00:01:00Z","message":{"content":[{"type":"text","text":"a"}]}}),
            json!({"type":"assistant","cwd":wt,"gitBranch":"feature","timestamp":"2026-10-01T00:01:00Z","message":{"content":[{"type":"text","text":"a"}]}}),
            json!({"type":"assistant","cwd":wt,"gitBranch":"feature","timestamp":"2026-10-01T00:01:00Z","message":{"content":[{"type":"text","text":"a"}]}}),
            json!({"type":"assistant","cwd":wt,"gitBranch":"feature","timestamp":"2026-10-01T00:01:00Z","message":{"content":[{"type":"text","text":"a"}]}}),
            json!({"type":"assistant","cwd":tmp.path().join("peek"),"gitBranch":"HEAD","timestamp":"2026-10-01T00:01:30Z","message":{"content":[{"type":"text","text":"잠깐"}]}}),
            json!({"type":"assistant","cwd":main,"gitBranch":"main","timestamp":"2026-10-01T00:02:00Z","message":{"content":[{"type":"text","text":"b"}]}}),
            json!({"type":"assistant","cwd":parent,"gitBranch":"HEAD","timestamp":"2026-10-01T00:03:00Z","message":{"content":[{"type":"text","text":"c"}]}}),
        ];
        std::fs::write(dir.join("up1.jsonl"), lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
        let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
        let s = core.list_sessions().unwrap().into_iter().find(|s| s.meta.id == "claude:up1").unwrap();
        assert_eq!(s.worktree_path.as_deref(), Some(main.to_str().unwrap()), "가장 최근에 일한 저장소 폴더");
        assert_eq!(s.other_worktrees, vec![wt.to_string_lossy().into_owned()], "앞서 일한 다른 워크트리에도 보임");
        assert_eq!(s.meta.last_branch, None, "상위 폴더의 HEAD 자리표시는 브랜치로 보이지 않게");
        assert_eq!(s.meta.cwd.as_deref(), Some(parent.to_str().unwrap()), "재개는 시작한 상위 폴더에서");
        assert!(s.cwd_exists);
        unsafe { std::env::remove_var("AITERM_HOME") };
    }

    fn chrono_like_iso(ms: i64) -> String {
        let secs = ms / 1000;
        let days = secs.div_euclid(86400);
        let rem = secs.rem_euclid(86400);
        // civil_from_days
        let z = days + 719468;
        let era = z.div_euclid(146097);
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
    }
}
