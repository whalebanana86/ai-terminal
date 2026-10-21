//! 파일 감시(FSEvents). 워크트리 파일 변경과 Git 메타데이터 변경을 구분해 알린다.

use anyhow::Result;
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer_opt, DebounceEventHandler, DebounceEventResult, Debouncer, NoCache};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WatchTarget {
    pub worktree: PathBuf,
    /// 이 워크트리 전용 git 폴더 (링크 워크트리는 워크트리 밖에 있다)
    pub git_dir: PathBuf,
    /// 공유 git 폴더 (refs, packed-refs)
    pub common_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeBatch {
    pub worktree: String,
    /// 워크트리 기준 상대 경로 (최대 500개)
    pub paths: Vec<String>,
    /// 파일 내용/목록이 바뀜
    pub files: bool,
    /// HEAD, index, refs 등 Git 상태가 바뀜
    pub git: bool,
}

pub type Emit = Arc<dyn Fn(ChangeBatch) + Send + Sync>;

/// 감시 대상에서 뺄 디렉터리 (워크트리 상대 경로 앞부분)
fn default_noise(rel: &str) -> bool {
    rel.split('/').any(|c| matches!(c, "node_modules" | ".DS_Store" | "__pycache__" | ".pytest_cache" | ".turbo" | ".next"))
}

/// .git 안에서 상태 변화와 무관한 잡음
fn git_noise(rel_in_git: &str) -> bool {
    rel_in_git.starts_with("objects/")
        || rel_in_git.starts_with("logs/")
        || rel_in_git.ends_with(".lock")
        || rel_in_git.starts_with("fsmonitor")
        || rel_in_git == "FETCH_HEAD"
}

/// 이벤트 경로를 대상별로 분류한다 (순수 함수, 테스트용).
pub fn classify(targets: &[WatchTarget], ignored: &HashMap<PathBuf, Vec<String>>, paths: &[PathBuf]) -> Vec<ChangeBatch> {
    let mut out: Vec<ChangeBatch> = targets
        .iter()
        .map(|t| ChangeBatch { worktree: t.worktree.to_string_lossy().into_owned(), ..Default::default() })
        .collect();
    let mut rels: Vec<BTreeSet<String>> = vec![BTreeSet::new(); targets.len()];
    for p in paths {
        for (i, t) in targets.iter().enumerate() {
            if let Ok(r) = p.strip_prefix(&t.git_dir) {
                if !git_noise(&r.to_string_lossy()) {
                    out[i].git = true;
                }
                continue;
            }
            if let Ok(r) = p.strip_prefix(&t.common_dir) {
                let r = r.to_string_lossy();
                // 다른 워크트리 전용 폴더(worktrees/<이름>/...) 의 HEAD 변화는 이 워크트리와 무관하지만
                // 워크트리 목록이 바뀐 것이므로 git 신호로 본다.
                if !git_noise(&r) {
                    out[i].git = true;
                }
                continue;
            }
            if let Ok(r) = p.strip_prefix(&t.worktree) {
                let rel = r.to_string_lossy().into_owned();
                if rel.is_empty() || rel == ".git" {
                    continue;
                }
                if rel.starts_with(".git/") {
                    // 메인 워크트리의 .git 은 git_dir 과 같아 위에서 처리됨. 여기 오는 건 서브모듈 등.
                    continue;
                }
                if default_noise(&rel) {
                    continue;
                }
                if ignored.get(&t.worktree).is_some_and(|pre| pre.iter().any(|x| rel == *x || rel.starts_with(&format!("{x}/")))) {
                    continue;
                }
                out[i].files = true;
                if rel == ".gitignore" || rel.ends_with("/.gitignore") {
                    out[i].git = true;
                }
                if rels[i].len() < 500 {
                    rels[i].insert(rel);
                }
            }
        }
    }
    for (b, r) in out.iter_mut().zip(rels) {
        b.paths = r.into_iter().collect();
    }
    out.into_iter().filter(|b| b.files || b.git).collect()
}

/// 파일 id 캐시 없이 만든다. 기본 캐시(FileIdMap)는 감시를 걸 때 하위 전체를 심볼릭 링크까지
/// 따라가며 훑어서 node_modules·target·홈을 가리키는 링크가 있으면 매우 느려진다. rename 짝 맞추기는
/// 이 앱에 필요 없다(경로만 쓴다).
fn debouncer<F: DebounceEventHandler>(timeout: Duration, f: F) -> Result<Debouncer<notify::RecommendedWatcher, NoCache>> {
    Ok(new_debouncer_opt::<F, notify::RecommendedWatcher, NoCache>(timeout, None, f, NoCache, notify::Config::default())?)
}

/// 무시 폴더 목록을 다시 계산하는 최소 간격 (빌드로 새로 생긴 target/, dist/ 반영)
const IGNORED_REFRESH: Duration = Duration::from_secs(20);

/// 무시되는 폴더(빌드 산출물 등) 목록. 이 아래 이벤트는 버린다.
fn ignored_dirs(worktree: &Path) -> Vec<String> {
    crate::git::run(worktree, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"])
        .map(|s| s.split('\0').filter(|x| x.ends_with('/')).map(|x| x.trim_end_matches('/').to_string()).collect())
        .unwrap_or_default()
}

pub struct WorkspaceWatcher {
    debouncer: Mutex<Debouncer<notify::RecommendedWatcher, NoCache>>,
    state: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    targets: Vec<WatchTarget>,
    ignored: HashMap<PathBuf, Vec<String>>,
    ignored_at: HashMap<PathBuf, std::time::Instant>,
    /// 감시 중인 경로와 그때의 inode. 폴더를 지웠다 다시 만들면 inode 가 바뀌어 감시를 다시 건다.
    watched: HashMap<PathBuf, u64>,
}

impl WorkspaceWatcher {
    pub fn new(emit: Emit) -> Result<Self> {
        let state: Arc<Mutex<State>> = Arc::default();
        let st = state.clone();
        let debouncer = debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let paths: Vec<PathBuf> = events.iter().flat_map(|e| e.paths.iter().cloned()).collect();
            if paths.is_empty() {
                return;
            }
            let (targets, ignored) = {
                let s = st.lock();
                (s.targets.clone(), s.ignored.clone())
            };
            for batch in classify(&targets, &ignored, &paths) {
                let wt = PathBuf::from(&batch.worktree);
                let stale = st.lock().ignored_at.get(&wt).is_none_or(|t| t.elapsed() > IGNORED_REFRESH);
                if stale || (batch.git && batch.paths.iter().any(|p| p.ends_with(".gitignore"))) {
                    let dirs = ignored_dirs(&wt);
                    let mut s = st.lock();
                    s.ignored.insert(wt.clone(), dirs);
                    s.ignored_at.insert(wt, std::time::Instant::now());
                }
                emit(batch);
            }
        })?;
        Ok(Self { debouncer: Mutex::new(debouncer), state })
    }

    /// 감시 대상 전체를 바꾼다. 이미 감시 중인 경로는 그대로 둔다.
    pub fn set_targets(&self, targets: Vec<WatchTarget>) -> Result<()> {
        let mut wanted: HashSet<PathBuf> = HashSet::new();
        for t in &targets {
            wanted.insert(t.worktree.clone());
            if !t.git_dir.starts_with(&t.worktree) {
                wanted.insert(t.git_dir.clone());
            }
            if !t.common_dir.starts_with(&t.worktree) {
                wanted.insert(t.common_dir.clone());
            }
        }
        // 다른 감시 경로 안에 포함된 경로는 빼서 중복 이벤트를 막는다.
        let roots: Vec<PathBuf> = wanted.iter().filter(|p| !wanted.iter().any(|q| q != *p && p.starts_with(q))).cloned().collect();
        let roots: HashSet<PathBuf> = roots.into_iter().collect();

        let mut new_ignored = HashMap::new();
        let mut new_at = HashMap::new();
        for t in &targets {
            let (existing, at) = {
                let s = self.state.lock();
                (s.ignored.get(&t.worktree).cloned(), s.ignored_at.get(&t.worktree).copied())
            };
            match (existing, at) {
                (Some(dirs), Some(at)) => {
                    new_ignored.insert(t.worktree.clone(), dirs);
                    new_at.insert(t.worktree.clone(), at);
                }
                _ => {
                    new_ignored.insert(t.worktree.clone(), ignored_dirs(&t.worktree));
                    new_at.insert(t.worktree.clone(), std::time::Instant::now());
                }
            }
        }

        let mut deb = self.debouncer.lock();
        let mut st = self.state.lock();
        let ino = |p: &Path| std::fs::metadata(p).map(|m| std::os::unix::fs::MetadataExt::ino(&m)).unwrap_or(0);
        let stale: Vec<PathBuf> = st
            .watched
            .iter()
            .filter(|(p, i)| !roots.contains(*p) || ino(p) != **i)
            .map(|(p, _)| p.clone())
            .collect();
        for old in stale {
            let _ = deb.unwatch(&old);
            st.watched.remove(&old);
        }
        for r in &roots {
            if st.watched.contains_key(r) {
                continue;
            }
            match deb.watch(r, RecursiveMode::Recursive) {
                Ok(()) => {
                    st.watched.insert(r.clone(), ino(r));
                }
                Err(e) => eprintln!("[watch] {} 감시 실패: {e}", r.display()),
            }
        }
        st.targets = targets;
        st.ignored = new_ignored;
        st.ignored_at = new_at;
        Ok(())
    }
}

/// Claude/Codex 세션 기록 폴더 감시. 의미 있는 변화만 알린다.
pub struct SessionWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, NoCache>,
}

impl SessionWatcher {
    pub fn new(claude_projects: PathBuf, codex_root: PathBuf, emit: Arc<dyn Fn(Vec<String>) + Send + Sync>) -> Result<Self> {
        // 파일 알림은 실제 경로(/tmp → /private/tmp 같은 링크를 푼 경로)로 오므로 비교도 실제 경로로 한다.
        let cp = std::fs::canonicalize(&claude_projects).unwrap_or_else(|_| claude_projects.clone());
        let cr = std::fs::canonicalize(&codex_root).unwrap_or_else(|_| codex_root.clone());
        let mut deb = debouncer(Duration::from_millis(800), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut hits = BTreeSet::new();
            for p in events.iter().flat_map(|e| e.paths.iter()) {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let relevant = if let Ok(r) = p.strip_prefix(&cp) {
                    // projects/<dir>/<uuid>.jsonl 만 (tool-results, subagents 하위 폴더 제외)
                    r.components().count() == 2 && name.ends_with(".jsonl")
                } else if let Ok(r) = p.strip_prefix(&cr) {
                    let r = r.to_string_lossy();
                    (r.starts_with("sessions/") && name.starts_with("rollout-")) || (name.starts_with("state_") && name.contains(".sqlite"))
                } else {
                    false
                };
                if relevant {
                    hits.insert(p.to_string_lossy().into_owned());
                }
            }
            if !hits.is_empty() {
                emit(hits.into_iter().collect());
            }
        })?;
        if claude_projects.is_dir() {
            deb.watch(&claude_projects, RecursiveMode::Recursive)?;
        }
        if codex_root.is_dir() {
            // ~/.codex 전체를 재귀로 보면 로그 DB 때문에 시끄럽다. sessions 는 재귀, 루트는 단일 단계.
            deb.watch(&codex_root, RecursiveMode::NonRecursive)?;
            let s = codex_root.join("sessions");
            if s.is_dir() {
                deb.watch(&s, RecursiveMode::Recursive)?;
            }
        }
        Ok(Self { _debouncer: deb })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(wt: &str, gd: &str, cd: &str) -> WatchTarget {
        WatchTarget { worktree: wt.into(), git_dir: gd.into(), common_dir: cd.into() }
    }

    #[test]
    fn session_watcher_sees_writes_under_symlinked_home() {
        // macOS 의 /tmp 는 /private/tmp 링크. 알림은 실제 경로로 온다.
        let d = tempfile::Builder::new().prefix("aiterm-sw").tempdir_in("/tmp").unwrap();
        let raw = std::path::PathBuf::from(format!("/tmp/{}", d.path().file_name().unwrap().to_string_lossy()));
        let projects = raw.join(".claude/projects");
        std::fs::create_dir_all(projects.join("p")).unwrap();
        let got = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let g = got.clone();
        let _w = SessionWatcher::new(projects.clone(), raw.join(".codex"), Arc::new(move |p| g.lock().unwrap().extend(p))).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(projects.join("p/s1.jsonl"), "{}\n").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while got.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(got.lock().unwrap().iter().any(|p| p.ends_with("p/s1.jsonl")), "세션 기록 변경을 알려야 한다");
    }

    #[test]
    fn classifies_files_and_git_per_worktree() {
        let targets = vec![
            t("/r", "/r/.git", "/r/.git"),
            t("/r-wt", "/r/.git/worktrees/r-wt", "/r/.git"),
        ];
        let mut ignored = HashMap::new();
        ignored.insert(PathBuf::from("/r"), vec!["target".to_string()]);
        let b = classify(
            &targets,
            &ignored,
            &[
                "/r/src/a.rs".into(),
                "/r/target/debug/x".into(),
                "/r/node_modules/p/index.js".into(),
                "/r/.git/objects/ab/cdef".into(),
                "/r-wt/README.md".into(),
                "/r/.git/worktrees/r-wt/HEAD".into(),
            ],
        );
        let main = b.iter().find(|x| x.worktree == "/r").unwrap();
        assert_eq!(main.paths, vec!["src/a.rs"]);
        assert!(main.files);
        // /r/.git/worktrees/r-wt/HEAD 는 공유 .git 안이라 메인에도 git 신호(워크트리 목록 변화)
        assert!(main.git);
        let wt = b.iter().find(|x| x.worktree == "/r-wt").unwrap();
        assert_eq!(wt.paths, vec!["README.md"]);
        assert!(wt.git, "linked worktree HEAD change must be a git signal");
    }

    #[test]
    fn objects_only_is_not_a_git_signal() {
        let targets = vec![t("/r", "/r/.git", "/r/.git")];
        let b = classify(&targets, &HashMap::new(), &["/r/.git/objects/aa/bb".into(), "/r/.git/index.lock".into()]);
        assert!(b.is_empty());
    }
}
