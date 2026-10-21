//! Git CLI 래퍼. 모든 Git 정보는 실제 `git` 출력(porcelain)에서만 얻는다.
//!
//! 읽기 명령은 `GIT_OPTIONAL_LOCKS=0` 으로 실행해서, 에이전트가 같은 워크트리에서
//! 작업하는 동안 앱의 조회가 `index.lock` 을 잡아 방해하지 않게 한다.

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::env::shell_env;

pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const NETWORK_TIMEOUT: Duration = Duration::from_secs(180);
pub(crate) const COMMIT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug)]
pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

/// 오류 메시지는 사용자에게 그대로 보여 줄 수 있게 git stderr 를 담는다.
#[derive(Debug)]
pub struct GitError {
    pub args: String,
    pub stderr: String,
    pub code: i32,
}

impl std::error::Error for GitError {}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = self.stderr.trim();
        if msg.is_empty() {
            write!(f, "git {} 실패 (종료 코드 {})", self.args, self.code)
        } else {
            write!(f, "{msg}")
        }
    }
}

pub fn git_command(cwd: &Path) -> Command {
    let git = crate::env::which("git").unwrap_or_else(|| PathBuf::from("/usr/bin/git"));
    let mut cmd = Command::new(git);
    cmd.current_dir(cwd)
        .env_clear()
        .envs(shell_env())
        // 비밀번호 입력을 기다리며 멈추지 않게 한다. 인증은 ssh-agent/키체인/credential helper 에 맡긴다.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // 경로는 글자 그대로: 파일명의 [1], *, ?, :(top) 이 glob/pathspec magic 으로 해석되지 않게
        .env("GIT_LITERAL_PATHSPECS", "1")
        // merge/rebase --continue 가 편집기를 띄워 멈추지 않게 한다(메시지는 git 기본값 사용).
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "core.pager=cat"])
        // 화면 조회만으로 저장소 설정(.git/config)에 적힌 외부 명령이 자동 실행되지 않게 한다.
        .args(["-c", "core.fsmonitor=false"])
        // 사용자 전역 설정이 diff 헤더 형식(a/ b/ 접두사)을 바꾸지 못하게 고정한다.
        .args(["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.suppressBlankEmpty=false"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

pub(crate) fn run_raw(cwd: &Path, args: &[&str], input: Option<&[u8]>, timeout: Duration) -> Result<GitOutput> {
    run_cmd(git_command(cwd), args, input, timeout)
}

pub(crate) fn run_cmd(mut cmd: Command, args: &[&str], input: Option<&[u8]>, timeout: Duration) -> Result<GitOutput> {
    cmd.args(args);
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn().context("git 실행 파일을 찾을 수 없습니다")?;
    // 입력은 별도 스레드에서 쓴다. 출력 파이프가 차서 git 이 멈추면 쓰기도 멈추는 교착을 막는다.
    let in_t = match (input, child.stdin.take()) {
        (Some(data), Some(mut stdin)) => {
            let data = data.to_vec();
            Some(std::thread::spawn(move || {
                let _ = stdin.write_all(&data);
            }))
        }
        _ => None,
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b);
        b
    });
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("git {} 이(가) {}초 안에 끝나지 않아 중단했습니다", args.join(" "), timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    if let Some(t) = in_t {
        let _ = t.join();
    }
    Ok(GitOutput {
        stdout: out_t.join().unwrap_or_default(),
        stderr: String::from_utf8_lossy(&err_t.join().unwrap_or_default()).into_owned(),
        code: status.code().unwrap_or(-1),
    })
}

pub(crate) fn check(args: &[&str], out: GitOutput) -> Result<Vec<u8>> {
    if out.code != 0 {
        return Err(GitError { args: args.join(" "), stderr: out.stderr, code: out.code }.into());
    }
    Ok(out.stdout)
}

pub fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = run_raw(cwd, args, None, READ_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&check(args, out)?).into_owned())
}

pub fn run_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = run_raw(cwd, args, None, READ_TIMEOUT)?;
    check(args, out)
}

fn run_network(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = run_raw(cwd, args, None, NETWORK_TIMEOUT)?;
    let stderr = out.stderr.clone();
    let stdout = check(args, out)?;
    // fetch/push 는 진행 메시지를 stderr 로 쓰므로 둘 다 돌려준다.
    Ok(format!("{}{}", String::from_utf8_lossy(&stdout), stderr))
}

fn canon(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
}

// ───────────────────────────── 위치 ─────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoLocation {
    /// 이 경로가 속한 워크트리 최상위 폴더
    pub toplevel: String,
    /// 저장소 정체성: 모든 워크트리가 공유하는 .git 폴더
    pub common_dir: String,
    /// 이 워크트리 전용 git 폴더 (메인은 common_dir 과 같고, 링크 워크트리는 .git/worktrees/<이름>)
    pub git_dir: String,
}

/// 경로가 Git 워크트리 안이면 위치를, 아니면 None 을 준다. 경로가 없으면 오류 대신 None.
pub fn locate(path: &Path) -> Result<Option<RepoLocation>> {
    if !path.is_dir() {
        return Ok(None);
    }
    let args = [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "--git-dir",
    ];
    let out = run_raw(path, &args, None, READ_TIMEOUT)?;
    if out.code != 0 {
        return Ok(None); // Git 저장소가 아니거나 bare 저장소
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let (Some(top), Some(common), Some(gd)) = (lines.next(), lines.next(), lines.next()) else {
        return Ok(None);
    };
    Ok(Some(RepoLocation { toplevel: canon(top), common_dir: canon(common), git_dir: canon(gd) }))
}

// ───────────────────────────── 워크트리 ─────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    /// `refs/heads/` 를 뗀 브랜치 이름. detached 면 None
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub is_main: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    /// 디스크에 폴더가 실제로 있는지
    pub exists: bool,
}

pub fn parse_worktrees_porcelain_z(raw: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for field in raw.split('\0') {
        if field.is_empty() {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            continue;
        }
        let (key, val) = field.split_once(' ').unwrap_or((field, ""));
        match key {
            "worktree" => {
                if let Some(w) = cur.take() {
                    list.push(w);
                }
                cur = Some(Worktree { path: val.to_string(), ..Default::default() });
            }
            _ => {
                let Some(w) = cur.as_mut() else { continue };
                match key {
                    "HEAD" => w.head = Some(val.to_string()),
                    "branch" => w.branch = Some(val.strip_prefix("refs/heads/").unwrap_or(val).to_string()),
                    "detached" => w.detached = true,
                    "bare" => w.bare = true,
                    "locked" => w.locked = Some(val.to_string()),
                    "prunable" => w.prunable = Some(val.to_string()),
                    _ => {}
                }
            }
        }
    }
    if let Some(w) = cur.take() {
        list.push(w);
    }
    if let Some(first) = list.first_mut() {
        first.is_main = true; // git 은 항상 메인 워크트리를 첫 번째로 출력한다
    }
    for w in &mut list {
        w.exists = Path::new(&w.path).is_dir();
        if w.exists {
            w.path = canon(&w.path);
        }
        if w.head.as_deref() == Some("0000000000000000000000000000000000000000") {
            w.head = None; // 아직 커밋이 없는 브랜치
        }
    }
    list
}

pub fn worktrees(any_path: &Path) -> Result<Vec<Worktree>> {
    let raw = run(any_path, &["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktrees_porcelain_z(&raw))
}

/// git 을 띄우지 않고 워크트리의 HEAD 를 파일에서 직접 읽는다(세션 목록처럼 자주 부르는 곳용).
/// 반환: (브랜치 이름, 커밋 sha, detached 여부). 읽을 수 없으면 None.
pub fn read_head(git_dir: &Path, common_dir: &Path) -> Option<(Option<String>, Option<String>, bool)> {
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref: ") {
        let branch = r.strip_prefix("refs/heads/").map(str::to_string);
        // 루즈 ref → packed-refs 순으로 찾는다. 아직 커밋이 없는 브랜치면 sha 없음.
        let sha = std::fs::read_to_string(common_dir.join(r))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() >= 40)
            .or_else(|| {
                let packed = std::fs::read_to_string(common_dir.join("packed-refs")).ok()?;
                packed.lines().find_map(|l| {
                    let (sha, name) = l.split_once(' ')?;
                    (name == r && !l.starts_with('#') && !l.starts_with('^')).then(|| sha.to_string())
                })
            });
        Some((branch, sha, false))
    } else if head.len() >= 40 && head.chars().all(|c| c.is_ascii_hexdigit()) {
        Some((None, Some(head.to_string()), true))
    } else {
        None
    }
}

// ───────────────────────────── HEAD / 상태 ─────────────────────────────

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    /// 스테이지(index) 상태 문자: M A D R C U . ?
    pub index: char,
    /// 워크트리 상태 문자
    pub worktree: char,
    /// modified | added | deleted | renamed | untracked | conflicted | ignored
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub entries: Vec<StatusEntry>,
    /// merge / rebase / cherry-pick / revert / bisect 진행 중이면 그 이름
    pub operation: Option<String>,
}

fn kind_of(x: char, y: char) -> &'static str {
    if x == 'R' || y == 'R' || x == 'C' {
        "renamed"
    } else if x == 'D' || y == 'D' {
        "deleted"
    } else if x == 'A' {
        "added"
    } else {
        "modified"
    }
}

pub fn parse_status_v2_z(raw: &str) -> WorktreeStatus {
    let mut st = WorktreeStatus::default();
    let mut fields = raw.split('\0').peekable();
    while let Some(f) = fields.next() {
        if f.is_empty() {
            continue;
        }
        if let Some(h) = f.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" => st.head = (v != "(initial)").then(|| v.to_string()),
                "branch.head" => {
                    if v == "(detached)" {
                        st.detached = true;
                    } else {
                        st.branch = Some(v.to_string());
                    }
                }
                "branch.upstream" => st.upstream = Some(v.to_string()),
                "branch.ab" => {
                    for part in v.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let (tag, rest) = f.split_at(1);
        // "? 이름" 처럼 태그 뒤 공백은 정확히 한 칸이다. trim 하면 공백으로 시작하는 파일명이 깨진다.
        let rest = rest.strip_prefix(' ').unwrap_or(rest);
        match tag {
            "1" => {
                // XY sub mH mI mW hH hI path
                let parts: Vec<&str> = rest.splitn(8, ' ').collect();
                if parts.len() == 8 {
                    let mut xy = parts[0].chars();
                    let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                    st.entries.push(StatusEntry {
                        path: parts[7].to_string(),
                        orig_path: None,
                        index: x,
                        worktree: y,
                        kind: kind_of(x, y).into(),
                    });
                }
            }
            "2" => {
                // XY sub mH mI mW hH hI Xscore path \0 origPath
                let parts: Vec<&str> = rest.splitn(9, ' ').collect();
                if parts.len() == 9 {
                    let mut xy = parts[0].chars();
                    let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                    let orig = fields.next().map(str::to_string);
                    st.entries.push(StatusEntry {
                        path: parts[8].to_string(),
                        orig_path: orig,
                        index: x,
                        worktree: y,
                        kind: "renamed".into(),
                    });
                }
            }
            "u" => {
                // XY sub m1 m2 m3 mW h1 h2 h3 path
                let parts: Vec<&str> = rest.splitn(10, ' ').collect();
                if parts.len() == 10 {
                    let mut xy = parts[0].chars();
                    st.entries.push(StatusEntry {
                        path: parts[9].to_string(),
                        orig_path: None,
                        index: xy.next().unwrap_or('U'),
                        worktree: xy.next().unwrap_or('U'),
                        kind: "conflicted".into(),
                    });
                }
            }
            "?" => st.entries.push(StatusEntry {
                path: rest.to_string(),
                orig_path: None,
                index: '?',
                worktree: '?',
                kind: "untracked".into(),
            }),
            "!" => st.entries.push(StatusEntry {
                path: rest.to_string(),
                orig_path: None,
                index: '!',
                worktree: '!',
                kind: "ignored".into(),
            }),
            _ => {}
        }
    }
    st
}

pub(crate) fn operation_in_progress(git_dir: &Path) -> Option<String> {
    if git_dir.join("rebase-merge").exists() {
        return Some("rebase".into());
    }
    if git_dir.join("rebase-apply").exists() {
        // rebase-apply 는 git am 때도 생긴다
        return Some(if git_dir.join("rebase-apply/applying").exists() { "am" } else { "rebase" }.into());
    }
    let checks = [("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")];
    if let Some((_, n)) = checks.iter().find(|(f, _)| git_dir.join(f).exists()) {
        return Some(n.to_string());
    }
    // 여러 커밋 cherry-pick/revert 도중 충돌 없이 멈춘 상태(sequencer 만 남음)
    if let Ok(todo) = std::fs::read_to_string(git_dir.join("sequencer/todo")) {
        let first = todo.lines().find(|l| !l.trim().is_empty() && !l.starts_with('#')).unwrap_or("");
        return Some(if first.starts_with("revert") { "revert" } else { "cherry-pick" }.into());
    }
    git_dir.join("BISECT_LOG").exists().then(|| "bisect".into())
}

pub fn status(worktree: &Path) -> Result<WorktreeStatus> {
    let raw = run(
        worktree,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--find-renames"],
    )?;
    let mut st = parse_status_v2_z(&raw);
    if let Some(loc) = locate(worktree)? {
        st.operation = operation_in_progress(Path::new(&loc.git_dir));
    }
    Ok(st)
}

// ───────────────────────────── 브랜치 / 참조 ─────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    /// 전체 이름 (refs/heads/main)
    pub name: String,
    /// 짧은 이름 (main, origin/main, v1.0)
    pub short: String,
    /// branch | remote | tag
    pub kind: String,
    /// 가리키는 커밋 (태그는 벗겨낸 커밋)
    pub target: String,
    pub upstream: Option<String>,
    /// "[ahead 1, behind 2]" 같은 git 표기
    pub track: Option<String>,
}

pub fn parse_refs(raw: &str) -> Vec<GitRef> {
    let mut out = Vec::new();
    for line in raw.split('\n') {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 5 {
            continue;
        }
        let name = f[1];
        let (kind, short) = if let Some(s) = name.strip_prefix("refs/heads/") {
            ("branch", s)
        } else if let Some(s) = name.strip_prefix("refs/remotes/") {
            if s.ends_with("/HEAD") {
                continue; // origin/HEAD 는 별칭이라 그래프에 겹쳐 그리지 않는다
            }
            ("remote", s)
        } else if let Some(s) = name.strip_prefix("refs/tags/") {
            ("tag", s)
        } else {
            continue;
        };
        let target = if f[2].is_empty() { f[0] } else { f[2] };
        out.push(GitRef {
            name: name.to_string(),
            short: short.to_string(),
            kind: kind.to_string(),
            target: target.to_string(),
            upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
            track: (!f[4].is_empty()).then(|| f[4].to_string()),
        });
    }
    out
}

pub fn refs(repo: &Path) -> Result<Vec<GitRef>> {
    let raw = run(
        repo,
        &[
            "for-each-ref",
            "--format=%(objectname)%1f%(refname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    Ok(parse_refs(&raw))
}

// ───────────────────────────── 로그 / 커밋 ─────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// 작성 시각 (유닉스 초)
    pub time: i64,
    pub subject: String,
}

pub fn parse_log(raw: &str) -> Vec<Commit> {
    raw.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            if rec.is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.splitn(6, '\x1f').collect();
            if f.len() < 6 {
                return None;
            }
            Some(Commit {
                sha: f[0].to_string(),
                parents: f[1].split(' ').filter(|s| !s.is_empty()).map(str::to_string).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                subject: f[5].trim_end_matches('\n').to_string(),
            })
        })
        .collect()
}

const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e";

/// 그래프용 커밋 목록. 모든 로컬/원격 브랜치·태그와 각 워크트리 HEAD 에서 출발한다.
pub fn log_for_graph(repo: &Path, extra_heads: &[String], limit: usize) -> Result<Vec<Commit>> {
    let n = format!("-n{limit}");
    let mut args: Vec<&str> =
        vec!["log", "--topo-order", LOG_FORMAT, &n, "--branches", "--remotes", "--tags"];
    // 워크트리 HEAD 가 detached 여도 그래프에 나오게 sha 를 직접 넘긴다.
    let heads: Vec<&str> = extra_heads.iter().map(String::as_str).collect();
    args.extend(heads.iter());
    args.push("--");
    let out = run_raw(repo, &args, None, READ_TIMEOUT)?;
    if out.code != 0 {
        // 커밋이 하나도 없는 새 저장소
        if out.stderr.contains("does not have any commits") || out.stderr.contains("bad default revision") {
            return Ok(Vec::new());
        }
        return Err(GitError { args: args.join(" "), stderr: out.stderr, code: out.code }.into());
    }
    Ok(parse_log(&String::from_utf8_lossy(&out.stdout)))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub message: String,
    pub files: Vec<StatusEntry>,
}

pub fn parse_name_status_z(raw: &str) -> Vec<StatusEntry> {
    let mut out = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(code) = it.next() {
        let c = code.chars().next().unwrap_or('M');
        if c == 'R' || c == 'C' {
            let (Some(from), Some(to)) = (it.next(), it.next()) else { break };
            out.push(StatusEntry {
                path: to.into(),
                orig_path: Some(from.into()),
                index: c,
                worktree: '.',
                kind: "renamed".into(),
            });
        } else {
            let Some(p) = it.next() else { break };
            let kind = match c {
                'A' => "added",
                'D' => "deleted",
                _ => "modified",
            };
            out.push(StatusEntry { path: p.into(), orig_path: None, index: c, worktree: '.', kind: kind.into() });
        }
    }
    out
}

pub fn commit_detail(repo: &Path, sha: &str) -> Result<CommitDetail> {
    validate_rev(sha)?;
    let raw = run(repo, &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B", sha, "--"])?;
    let f: Vec<&str> = raw.splitn(8, '\x1f').collect();
    if f.len() < 8 {
        bail!("커밋 정보를 읽을 수 없습니다: {sha}");
    }
    let parents: Vec<String> = f[1].split(' ').filter(|s| !s.is_empty()).map(str::to_string).collect();
    let files_raw = if let Some(p0) = parents.first() {
        run(repo, &["diff-tree", "-r", "-M", "--name-status", "-z", p0, f[0]])?
    } else {
        run(repo, &["diff-tree", "-r", "--root", "--name-status", "-z", "--no-commit-id", f[0]])?
    };
    Ok(CommitDetail {
        sha: f[0].into(),
        parents,
        author: f[2].into(),
        email: f[3].into(),
        time: f[4].parse().unwrap_or(0),
        committer: f[5].into(),
        commit_time: f[6].parse().unwrap_or(0),
        message: f[7].trim_end().into(),
        files: parse_name_status_z(&files_raw),
    })
}

/// 사용자 입력이 git 옵션으로 해석되지 않게 막는다.
pub fn validate_rev(rev: &str) -> Result<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.contains(['\0', '\n', ' ']) {
        bail!("올바르지 않은 리비전: {rev:?}");
    }
    Ok(())
}

// ───────────────────────────── diff ─────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// ' ' 문맥, '+' 추가, '-' 삭제, '\\' "No newline at end of file"
    pub kind: char,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
    /// hunk 원문의 지문. 스테이징 요청 때 화면에서 본 hunk 와 지금 hunk 가 같은지 확인한다.
    pub id: String,
}

/// 짧은 지문(FNV-1a 64)
pub fn fingerprint(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    pub additions: u32,
    pub deletions: u32,
}

fn parse_hunk_header(h: &str) -> (u32, u32) {
    // @@ -a,b +c,d @@
    let mut old = 0;
    let mut new = 0;
    for tok in h.split(' ') {
        if let Some(r) = tok.strip_prefix('-') {
            old = r.split(',').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        } else if let Some(r) = tok.strip_prefix('+') {
            new = r.split(',').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
    }
    (old, new)
}

/// git 이 `"a/q\"uote.txt"` 처럼 C 스타일로 감싼 경로를 원래 문자열로 되돌린다.
pub fn unquote_c_path(p: &str) -> String {
    let Some(inner) = p.strip_prefix('"').and_then(|x| x.strip_suffix('"')) else { return p.to_string() };
    let mut bytes = Vec::new();
    let mut it = inner.bytes().peekable();
    while let Some(b) = it.next() {
        if b != b'\\' {
            bytes.push(b);
            continue;
        }
        match it.next() {
            Some(b'n') => bytes.push(b'\n'),
            Some(b't') => bytes.push(b'\t'),
            Some(b'r') => bytes.push(b'\r'),
            Some(b'a') => bytes.push(7),
            Some(b'b') => bytes.push(8),
            Some(b'f') => bytes.push(12),
            Some(b'v') => bytes.push(11),
            Some(d @ b'0'..=b'7') => {
                // 8진수 3자리 (UTF-8 바이트)
                let mut v = (d - b'0') as u32;
                for _ in 0..2 {
                    if let Some(&n @ b'0'..=b'7') = it.peek() {
                        v = v * 8 + (n - b'0') as u32;
                        it.next();
                    }
                }
                bytes.push(v as u8);
            }
            Some(other) => bytes.push(other),
            None => {}
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn strip_diff_path(p: &str) -> Option<String> {
    let p = p.trim_end_matches('\t');
    if p == "/dev/null" {
        return None;
    }
    let p = unquote_c_path(p);
    Some(p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(&p).to_string())
}

pub fn parse_unified_diff(raw: &str) -> Vec<FileDiff> {
    // 헤더(@@) 다음 줄부터 다음 헤더 전까지가 hunk 원문이다. id 는 split_patch 와 같은 규칙으로 만든다.
    let mut files: Vec<FileDiff> = Vec::new();
    let mut hunk_raw = String::new();
    let mut old_no = 0u32;
    let mut new_no = 0u32;
    for line in raw.split('\n') {
        if line.starts_with("diff --git ") {
            files.push(FileDiff::default());
            continue;
        }
        let Some(file) = files.last_mut() else { continue };
        if file.hunks.is_empty() {
            if let Some(p) = line.strip_prefix("--- ") {
                file.old_path = strip_diff_path(p);
            } else if let Some(p) = line.strip_prefix("+++ ") {
                file.new_path = strip_diff_path(p);
            } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                file.binary = true;
            } else if let Some(p) = line.strip_prefix("rename from ") {
                file.old_path = Some(unquote_c_path(p));
            } else if let Some(p) = line.strip_prefix("rename to ") {
                file.new_path = Some(unquote_c_path(p));
            }
        }
        if line.starts_with("@@") {
            let (o, n) = parse_hunk_header(line);
            old_no = o;
            new_no = n;
            file.hunks.push(DiffHunk { header: line.to_string(), lines: Vec::new(), id: String::new() });
            hunk_raw.clear();
            hunk_raw.push_str(line);
            hunk_raw.push('\n');
            continue;
        }
        let Some(hunk) = file.hunks.last_mut() else { continue };
        let Some(first) = line.chars().next() else { continue };
        if matches!(first, ' ' | '+' | '-' | '\\') {
            hunk_raw.push_str(line);
            hunk_raw.push('\n');
            hunk.id = fingerprint(&hunk_raw);
        }
        let text = line[first.len_utf8()..].to_string();
        match first {
            ' ' => {
                hunk.lines.push(DiffLine { kind: ' ', old_no: Some(old_no), new_no: Some(new_no), text });
                old_no += 1;
                new_no += 1;
            }
            '+' => {
                hunk.lines.push(DiffLine { kind: '+', old_no: None, new_no: Some(new_no), text });
                new_no += 1;
                file.additions += 1;
            }
            '-' => {
                hunk.lines.push(DiffLine { kind: '-', old_no: Some(old_no), new_no: None, text });
                old_no += 1;
                file.deletions += 1;
            }
            '\\' => hunk.lines.push(DiffLine { kind: '\\', old_no: None, new_no: None, text }),
            _ => {}
        }
    }
    files
}

/// 경로가 워크트리 밖을 가리키지 않는지 확인한다.
pub fn safe_rel_path(rel: &str) -> Result<()> {
    let p = Path::new(rel);
    if rel.is_empty()
        || p.is_absolute()
        || p.components().any(|c| matches!(c, std::path::Component::ParentDir))
        || rel.contains('\0')
        // "." / "./" 처럼 워크트리 전체를 가리키는 경로는 파일 작업에 쓰지 않는다
        || p.components().all(|c| matches!(c, std::path::Component::CurDir))
    {
        bail!("올바르지 않은 경로: {rel}");
    }
    Ok(())
}

/// 워크트리 파일의 HEAD 대비 변경(스테이지 + 미스테이지 합계). 추적되지 않은 파일은 새 파일 diff.
pub fn diff_worktree_file(worktree: &Path, rel: &str) -> Result<Vec<FileDiff>> {
    safe_rel_path(rel)?;
    let tracked = run_raw(worktree, &["ls-files", "--error-unmatch", "--", rel], None, READ_TIMEOUT)?.code == 0;
    let has_head = run_raw(worktree, &["rev-parse", "--verify", "-q", "HEAD"], None, READ_TIMEOUT)?.code == 0;
    let raw = if tracked && has_head {
        run(worktree, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "HEAD", "--", rel])?
    } else if worktree.join(rel).exists() {
        // --no-index 는 차이가 있으면 종료 코드 1 을 준다.
        let out = run_raw(
            worktree,
            &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-index", "--", "/dev/null", rel],
            None,
            READ_TIMEOUT,
        )?;
        if out.code > 1 {
            return Err(GitError { args: "diff --no-index".into(), stderr: out.stderr, code: out.code }.into());
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        // 아직 커밋이 없는 저장소에서 스테이지만 된 파일이 지워진 경우 등
        run(worktree, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--cached", "--", rel])?
    };
    Ok(parse_unified_diff(&raw))
}

/// 커밋 하나에서 파일 하나의 변경 (첫 부모 기준)
pub fn diff_commit_file(repo: &Path, sha: &str, rel: &str) -> Result<Vec<FileDiff>> {
    validate_rev(sha)?;
    safe_rel_path(rel)?;
    let parents = run(repo, &["rev-list", "--parents", "-n1", sha, "--"])?;
    let parent = parents.split_whitespace().nth(1).map(str::to_string);
    let raw = match parent {
        Some(p) => run(repo, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", &p, sha, "--", rel])?,
        None => run(repo, &["show", "--no-ext-diff", "--no-textconv", "--no-color", "--format=", sha, "--", rel])?,
    };
    Ok(parse_unified_diff(&raw))
}

// ───────────────────────────── 쓰기 작업 ─────────────────────────────
// 모든 쓰기 작업은 UI 에서 사용자가 버튼을 누르고 확인한 뒤에만 호출된다.

pub fn fetch(worktree: &Path) -> Result<String> {
    run_network(worktree, &["fetch", "--all", "--prune"])
}

pub fn pull_ff_only(worktree: &Path) -> Result<String> {
    run_network(worktree, &["pull", "--ff-only"])
}

pub fn push(worktree: &Path, set_upstream_remote: Option<&str>) -> Result<String> {
    match set_upstream_remote {
        Some(remote) => {
            validate_rev(remote)?;
            run_network(worktree, &["push", "-u", remote, "HEAD"])
        }
        None => run_network(worktree, &["push"]),
    }
}

pub fn commit(worktree: &Path, paths: &[String], message: &str) -> Result<String> {
    if message.trim().is_empty() {
        bail!("커밋 메시지를 입력하세요");
    }
    if paths.is_empty() {
        bail!("커밋할 파일을 하나 이상 고르세요");
    }
    for p in paths {
        safe_rel_path(p)?;
        if p.ends_with('/') {
            // status 가 "dir/" 로 보여 주는 건 중첩 저장소/링크 워크트리다. 커밋하면 gitlink 가 된다.
            bail!("'{p}' 는 안쪽에 다른 Git 저장소(또는 워크트리)가 있는 폴더라 커밋하지 않습니다");
        }
    }
    // 1) 디스크에 있거나 index 에 있는 경로만 add (git mv 의 원래 경로처럼 둘 다 없는 경로는 add 가 실패한다)
    let in_index: std::collections::HashSet<String> = run(worktree, &["ls-files", "-z", "--cached"])?
        .split('\0')
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect();
    let addable: Vec<&str> =
        paths.iter().filter(|p| worktree.join(p).symlink_metadata().is_ok() || in_index.contains(*p)).map(String::as_str).collect();
    if !addable.is_empty() {
        let mut add: Vec<&str> = vec!["add", "-A", "--"];
        add.extend(addable);
        run(worktree, &add)?;
    }
    // 2) 커밋은 index 나 HEAD 에 있는 경로만 (추가 후 삭제(AD)된 파일은 add 로 index 에서 빠져 둘 다 없음)
    let in_index: std::collections::HashSet<String> = run(worktree, &["ls-files", "-z", "--cached"])?
        .split('\0')
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect();
    let has_head = run_raw(worktree, &["rev-parse", "--verify", "-q", "HEAD"], None, READ_TIMEOUT)?.code == 0;
    let in_head: std::collections::HashSet<String> = if has_head {
        run(worktree, &["ls-tree", "-r", "-z", "--name-only", "HEAD"])?.split('\0').filter(|x| !x.is_empty()).map(str::to_string).collect()
    } else {
        Default::default()
    };
    let committable: Vec<&str> =
        paths.iter().filter(|p| in_index.contains(*p) || in_head.contains(*p)).map(String::as_str).collect();
    if committable.is_empty() {
        bail!("커밋할 변경이 남아 있지 않습니다");
    }
    // 메시지는 표준입력으로 넘겨 따옴표·줄바꿈 문제를 없앤다. 경로를 주면 그 파일만 커밋된다(--only).
    let mut args: Vec<&str> = vec!["commit", "-F", "-", "--"];
    args.extend(committable);
    // pre-commit 훅(lint, 테스트)이 오래 걸릴 수 있으므로 읽기 명령보다 길게 기다린다.
    let out = run_raw(worktree, &args, Some(message.as_bytes()), COMMIT_TIMEOUT)?;
    let stdout = check(&args, out)?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// 명시적 체크아웃. target 이 로컬 브랜치면 그 브랜치로, 원격 브랜치면 추적 브랜치를 만들어,
/// 커밋이면 detached 로 이동한다. --force 는 절대 쓰지 않는다.
pub fn checkout(worktree: &Path, target: &str, kind: &str) -> Result<String> {
    validate_rev(target)?;
    let out = match kind {
        "branch" => run(worktree, &["switch", target])?,
        "remote" => {
            let local = target.split_once('/').map(|(_, b)| b).ok_or_else(|| anyhow!("원격 브랜치 이름이 아닙니다"))?;
            validate_rev(local)?;
            let exists = run_raw(worktree, &["rev-parse", "--verify", "-q", &format!("refs/heads/{local}")], None, READ_TIMEOUT)?.code == 0;
            if exists {
                run(worktree, &["switch", local])?
            } else {
                run(worktree, &["switch", "--track", target])?
            }
        }
        _ => run(worktree, &["switch", "--detach", target])?,
    };
    Ok(out)
}

pub fn remotes(worktree: &Path) -> Result<Vec<String>> {
    Ok(run(worktree, &["remote"])?.lines().map(str::to_string).filter(|s| !s.is_empty()).collect())
}

/// 파일 목록 중 .gitignore 로 무시되는 것만 돌려준다.
pub fn check_ignored(worktree: &Path, rels: &[String]) -> Result<Vec<String>> {
    if rels.is_empty() {
        return Ok(Vec::new());
    }
    let input = rels.join("\0");
    // check-ignore 는 pathspec 이 아닌 경로를 받으며 literal 모드를 지원하지 않는다(켜면 오류).
    let mut cmd = git_command(worktree);
    cmd.env_remove("GIT_LITERAL_PATHSPECS");
    let out = run_cmd(cmd, &["check-ignore", "-z", "--stdin"], Some(input.as_bytes()), READ_TIMEOUT)?;
    // 종료 코드 1 = 무시되는 파일 없음
    if out.code > 1 {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_list() {
        let raw = "worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0worktree /repo-wt\0HEAD bbb\0detached\0locked reason\0\0worktree /gone\0HEAD ccc\0branch refs/heads/feat/x\0prunable gitdir file points to non-existent location\0\0";
        let w = parse_worktrees_porcelain_z(raw);
        assert_eq!(w.len(), 3);
        assert!(w[0].is_main && !w[1].is_main);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert!(w[1].detached && w[1].branch.is_none());
        assert_eq!(w[1].locked.as_deref(), Some("reason"));
        assert_eq!(w[2].branch.as_deref(), Some("feat/x"));
        assert!(w[2].prunable.is_some());
        assert!(!w[2].exists);
    }

    #[test]
    fn parses_status_v2() {
        let raw = "# branch.oid 1234\0# branch.head feat\0# branch.upstream origin/feat\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa aaa src/a b.rs\0\
1 A. N... 000000 100644 100644 000 bbb new.txt\0\
2 R. N... 100644 100644 100644 ccc ccc R100 renamed.rs\0old.rs\0\
u UU N... 100644 100644 100644 100644 d e f conflict.txt\0\
? 한글 파일.md\0";
        let st = parse_status_v2_z(raw);
        assert_eq!(st.head.as_deref(), Some("1234"));
        assert_eq!(st.branch.as_deref(), Some("feat"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        let kinds: Vec<(&str, &str)> = st.entries.iter().map(|e| (e.path.as_str(), e.kind.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                ("src/a b.rs", "modified"),
                ("new.txt", "added"),
                ("renamed.rs", "renamed"),
                ("conflict.txt", "conflicted"),
                ("한글 파일.md", "untracked")
            ]
        );
        assert_eq!(st.entries[2].orig_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn parses_detached_initial_status() {
        let st = parse_status_v2_z("# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(st.head.is_none() && st.detached && st.branch.is_none());
    }

    #[test]
    fn parses_refs_and_skips_origin_head() {
        let raw = "a1\x1frefs/heads/main\x1f\x1forigin/main\x1f[ahead 1]\nb2\x1frefs/remotes/origin/HEAD\x1f\x1f\x1f\nb2\x1frefs/remotes/origin/main\x1f\x1f\x1f\nt0\x1frefs/tags/v1\x1fc3\x1f\x1f\n";
        let r = parse_refs(raw);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!(r[2].target, "c3", "annotated tag must be peeled");
    }

    #[test]
    fn parses_unified_diff() {
        let raw = "diff --git a/x.txt b/x.txt\nindex 1..2 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\ndiff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hello\n";
        let d = parse_unified_diff(raw);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].old_path.as_deref(), Some("x.txt"));
        assert_eq!((d[0].additions, d[0].deletions), (1, 1));
        let l = &d[0].hunks[0].lines;
        assert_eq!((l[1].kind, l[1].old_no, l[1].new_no), ('-', Some(2), None));
        assert_eq!((l[2].kind, l[2].old_no, l[2].new_no), ('+', None, Some(2)));
        assert_eq!((l[3].old_no, l[3].new_no), (Some(3), Some(3)));
        assert_eq!(d[1].old_path, None);
        assert_eq!(d[1].new_path.as_deref(), Some("n.txt"));
    }

    #[test]
    fn rejects_dangerous_input() {
        assert!(validate_rev("--upload-pack=x").is_err());
        assert!(safe_rel_path("../etc/passwd").is_err());
        assert!(safe_rel_path("/etc/passwd").is_err());
        assert!(safe_rel_path("src/main.rs").is_ok());
    }

    fn temp_repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let ok = std::process::Command::new("git").args(["init", "-q"]).current_dir(d.path()).status().unwrap();
        assert!(ok.success());
        d
    }

    #[test]
    fn check_ignore_with_huge_input_does_not_deadlock() {
        let d = temp_repo();
        std::fs::write(d.path().join(".gitignore"), "target/\n").unwrap();
        let many: Vec<String> = (0..30_000).map(|i| format!("target/debug/deps/file-{i:05}.rlib")).collect();
        let start = std::time::Instant::now();
        let ignored = check_ignored(d.path(), &many).unwrap();
        assert_eq!(ignored.len(), many.len());
        assert!(start.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn literal_pathspecs_commit_only_the_named_file() {
        let d = temp_repo();
        let p = d.path();
        let g = |a: &[&str]| {
            let o = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(a).current_dir(p).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        };
        std::fs::write(p.join("seed"), "0").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "seed"]);
        std::fs::write(p.join("foo[1].txt"), "a").unwrap();
        std::fs::write(p.join("foo1.txt"), "b").unwrap();
        std::fs::write(p.join("-dash.txt"), "c").unwrap();
        // 사용자 이름이 설정되지 않은 환경을 대비해 저장소에 설정
        g(&["config", "user.name", "t"]);
        g(&["config", "user.email", "t@t"]);
        commit(p, &["foo[1].txt".into(), "-dash.txt".into()], "two files").unwrap();
        let st = status(p).unwrap();
        let left: Vec<_> = st.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(left, vec!["foo1.txt"], "glob must not pull in foo1.txt");
    }

    #[test]
    fn commit_handles_staged_rename_and_added_then_deleted() {
        let d = temp_repo();
        let p = d.path();
        let g = |a: &[&str]| {
            let o = std::process::Command::new("git").args(a).current_dir(p).output().unwrap();
            assert!(o.status.success(), "{a:?} {}", String::from_utf8_lossy(&o.stderr));
        };
        g(&["config", "user.name", "t"]);
        g(&["config", "user.email", "t@t"]);
        std::fs::write(p.join("page.tsx"), "x").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "seed"]);
        g(&["mv", "page.tsx", "moved.tsx"]);
        std::fs::write(p.join("z.txt"), "z").unwrap();
        g(&["add", "z.txt"]);
        std::fs::remove_file(p.join("z.txt")).unwrap(); // AD
        let st = status(p).unwrap();
        let mut paths: Vec<String> = Vec::new();
        for e in &st.entries {
            paths.push(e.path.clone());
            if let Some(o) = &e.orig_path {
                paths.push(o.clone());
            }
        }
        commit(p, &paths, "rename").unwrap();
        assert!(status(p).unwrap().entries.is_empty(), "{:?}", status(p).unwrap().entries);
    }

    #[test]
    fn leading_space_and_quoted_names() {
        let st = parse_status_v2_z("?  lead.txt\0");
        assert_eq!(st.entries[0].path, " lead.txt");
        assert_eq!(unquote_c_path(r#""a/q\"uote.txt""#), "a/q\"uote.txt");
        assert_eq!(unquote_c_path(r#""a/\355\225\234.txt""#), "a/한.txt");
        let d = parse_unified_diff("diff --git \"a/q\\\"x\" \"b/q\\\"x\"\n--- \"a/q\\\"x\"\n+++ \"b/q\\\"x\"\n@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(d[0].new_path.as_deref(), Some("q\"x"));
    }

    #[test]
    fn read_head_matches_git_cli() {
        let d = temp_repo();
        let p = d.path();
        let g = |dir: &Path, a: &[&str]| {
            let o = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(a).current_dir(dir).output().unwrap();
            assert!(o.status.success(), "{a:?} {}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };
        let loc = |dir: &Path| locate(dir).unwrap().unwrap();
        // 커밋 없는 브랜치
        let l = loc(p);
        assert_eq!(read_head(Path::new(&l.git_dir), Path::new(&l.common_dir)), Some((Some(g(p, &["symbolic-ref", "--short", "HEAD"])), None, false)));
        std::fs::write(p.join("a"), "1").unwrap();
        g(p, &["add", "."]);
        g(p, &["commit", "-qm", "c"]);
        let sha = g(p, &["rev-parse", "HEAD"]);
        let (b, s, det) = read_head(Path::new(&l.git_dir), Path::new(&l.common_dir)).unwrap();
        assert_eq!((b.as_deref(), s.as_deref(), det), (Some(g(p, &["symbolic-ref", "--short", "HEAD"]).as_str()), Some(sha.as_str()), false));
        // packed-refs 로 옮겨도 같은 값
        g(p, &["pack-refs", "--all"]);
        assert_eq!(read_head(Path::new(&l.git_dir), Path::new(&l.common_dir)).unwrap().1.as_deref(), Some(sha.as_str()));
        // 링크 워크트리(detached)
        let wt = d.path().parent().unwrap().join(format!("{}-wt", d.path().file_name().unwrap().to_string_lossy()));
        g(p, &["worktree", "add", "-q", "--detach", wt.to_str().unwrap()]);
        let lw = loc(&wt);
        assert_eq!(read_head(Path::new(&lw.git_dir), Path::new(&lw.common_dir)), Some((None, Some(sha.clone()), true)));
        g(&wt, &["switch", "-q", "-c", "side"]);
        assert_eq!(read_head(Path::new(&lw.git_dir), Path::new(&lw.common_dir)).unwrap().0.as_deref(), Some("side"));
        g(p, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
    }

    #[test]
    fn parses_log_records() {
        let raw = "aaa\x1fbbb ccc\x1fKim\x1fk@x\x1f100\x1fmerge: x\x1e\nbbb\x1f\x1fKim\x1fk@x\x1f50\x1finit\x1e\n";
        let c = parse_log(raw);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["bbb", "ccc"]);
        assert!(c[1].parents.is_empty());
    }
}
