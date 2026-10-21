//! 프런트엔드에 노출하는 Tauri 명령. 무거운 작업은 모두 blocking 스레드에서 돈다.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::core::{AppCore, ExecInfo, GraphData, LinkedSession, RepoSummary, StartRequest};
use crate::db::RepoRow;
use crate::files::{DirEntry, FileContent};
use crate::git::{self, CommitDetail, FileDiff, Worktree, WorktreeStatus};
use crate::sessions::Transcript;
use crate::watch::WorkspaceWatcher;

pub struct AppState {
    pub core: Arc<AppCore>,
    pub watcher: Option<Arc<WorkspaceWatcher>>,
}

type Res<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    // git 오류는 stderr 원문, 나머지는 원인 체인을 붙여 보여 준다.
    if let Some(g) = e.downcast_ref::<git::GitError>() {
        return g.to_string();
    }
    format!("{e:#}")
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub git: Option<String>,
    pub git_version: Option<String>,
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub claude_dir: String,
    pub codex_dir: String,
    pub data_dir: String,
    /// 테스트 자동화 빌드인지 (화면이 테스트용 객체를 노출할지 결정)
    pub automation: bool,
}

#[tauri::command]
pub async fn app_info(app: tauri::AppHandle) -> Res<AppInfo> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    blocking(move || {
        let w = |p: &str| crate::env::which(p).map(|p| p.to_string_lossy().into_owned());
        let git_version = git::run(Path::new("/"), &["--version"]).ok().map(|s| s.trim().to_string());
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            git: w("git"),
            git_version,
            claude: w("claude"),
            codex: w("codex"),
            claude_dir: crate::sessions::claude_dir().to_string_lossy().into_owned(),
            codex_dir: crate::sessions::codex_dir().to_string_lossy().into_owned(),
            data_dir,
            automation: cfg!(feature = "automation"),
        })
    })
    .await
}

// ───────────── 저장소 ─────────────

#[tauri::command]
pub async fn repo_list(state: State<'_, AppState>) -> Res<Vec<RepoSummary>> {
    let core = state.core.clone();
    blocking(move || core.list_repos()).await
}

#[tauri::command]
pub async fn repo_add(state: State<'_, AppState>, path: String) -> Res<RepoRow> {
    let core = state.core.clone();
    blocking(move || core.add_repo(&path)).await
}

#[tauri::command]
pub async fn repo_set_pinned(state: State<'_, AppState>, id: String, pinned: bool) -> Res<()> {
    let core = state.core.clone();
    blocking(move || core.db.set_repo_pinned(&id, pinned)).await
}

#[tauri::command]
pub async fn git_worktrees(state: State<'_, AppState>, path: String) -> Res<Vec<Worktree>> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::worktrees(Path::new(&path))
    })
    .await
}

// ───────────── Git 조회 ─────────────

#[tauri::command]
pub async fn git_graph(state: State<'_, AppState>, path: String, limit: Option<usize>) -> Res<GraphData> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        core.graph(&path, limit.unwrap_or(1500).clamp(50, 20000))
    })
    .await
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, path: String) -> Res<WorktreeStatus> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::status(Path::new(&path))
    })
    .await
}

#[tauri::command]
pub async fn git_commit_detail(state: State<'_, AppState>, path: String, sha: String) -> Res<CommitDetail> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::commit_detail(Path::new(&path), &sha)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_file(state: State<'_, AppState>, path: String, rel: String) -> Res<Vec<FileDiff>> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::diff_worktree_file(Path::new(&path), &rel)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_commit_file(state: State<'_, AppState>, path: String, sha: String, rel: String) -> Res<Vec<FileDiff>> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::diff_commit_file(Path::new(&path), &sha, &rel)
    })
    .await
}

#[tauri::command]
pub async fn git_remotes(state: State<'_, AppState>, path: String) -> Res<Vec<String>> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::remotes(Path::new(&path))
    })
    .await
}

// ───────────── Git 쓰기 (UI 확인 후에만 호출) ─────────────

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, path: String) -> Res<String> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::fetch(Path::new(&path))
    })
    .await
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, path: String) -> Res<String> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::pull_ff_only(Path::new(&path))
    })
    .await
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, path: String, set_upstream_remote: Option<String>) -> Res<String> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::push(Path::new(&path), set_upstream_remote.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, path: String, paths: Vec<String>, message: String) -> Res<String> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::commit(Path::new(&path), &paths, &message)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout(state: State<'_, AppState>, path: String, target: String, kind: String) -> Res<String> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        git::checkout(Path::new(&path), &target, &kind)
    })
    .await
}

// ───────────── 파일 ─────────────

#[tauri::command]
pub async fn fs_list(state: State<'_, AppState>, worktree: String, rel: String) -> Res<Vec<DirEntry>> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&worktree)?;
        crate::files::list_dir(Path::new(&worktree), &rel)
    })
    .await
}

#[tauri::command]
pub async fn fs_read(state: State<'_, AppState>, worktree: String, rel: String) -> Res<FileContent> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&worktree)?;
        crate::files::read_file(Path::new(&worktree), &rel)
    })
    .await
}

/// 화면 언어("ko"/"en"). 백엔드가 만드는 메시지(오류 등)도 이 언어로 쓴다.
#[tauri::command]
pub fn set_lang(app: tauri::AppHandle, lang: String) {
    crate::i18n::set_english(lang == "en");
    if let Err(error) = crate::brand::apply_language(&app) {
        eprintln!("[branding] {error}");
    }
}

/// 그림 파일 바이트를 그대로(JSON 변환 없이) 돌려준다. rev = "HEAD" 면 마지막 커밋의 그림.
#[tauri::command]
pub async fn fs_read_image(state: State<'_, AppState>, worktree: String, rel: String, rev: Option<String>) -> Res<tauri::ipc::Response> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&worktree)?;
        crate::files::read_image(Path::new(&worktree), &rel, rev.as_deref()).map(tauri::ipc::Response::new)
    })
    .await
}

// ───────────── 세션 ─────────────

#[tauri::command]
pub async fn sessions_list(state: State<'_, AppState>) -> Res<Vec<LinkedSession>> {
    let core = state.core.clone();
    blocking(move || core.list_sessions()).await
}

#[tauri::command]
pub async fn session_transcript(state: State<'_, AppState>, id: String) -> Res<Transcript> {
    let core = state.core.clone();
    blocking(move || core.transcript(&id)).await
}

// ───────────── 실행 (PTY) ─────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub agent: String,
    pub mode: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub force: bool,
    pub prompt: Option<String>,
}

#[tauri::command]
pub async fn exec_start(state: State<'_, AppState>, args: StartArgs) -> Res<ExecInfo> {
    let core = state.core.clone();
    blocking(move || {
        core.start(StartRequest {
            agent: args.agent,
            mode: args.mode,
            session_id: args.session_id,
            cwd: args.cwd,
            cols: args.cols,
            rows: args.rows,
            force: args.force,
            prompt: args.prompt,
        })
    })
    .await
}

#[tauri::command]
pub fn exec_attach(state: State<'_, AppState>, id: String, on_data: Channel<InvokeResponseBody>) -> Res<u64> {
    state
        .core
        .pty
        .attach(&id, Box::new(move |bytes: &[u8]| on_data.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok()))
        .map_err(err)
}

#[tauri::command]
pub fn exec_detach(state: State<'_, AppState>, id: String, sink_id: u64) {
    state.core.pty.detach(&id, sink_id);
}

#[tauri::command]
pub fn exec_write(state: State<'_, AppState>, id: String, data: String) -> Res<()> {
    state.core.pty.write(&id, data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn exec_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Res<()> {
    state.core.pty.resize(&id, cols, rows).map_err(err)
}

#[tauri::command]
pub fn exec_kill(state: State<'_, AppState>, id: String) -> Res<()> {
    state.core.pty.kill(&id).map_err(err)
}

#[tauri::command]
pub fn exec_list(state: State<'_, AppState>) -> Vec<ExecInfo> {
    state.core.exec_list()
}

#[tauri::command]
pub async fn exec_history(state: State<'_, AppState>, limit: Option<usize>) -> Res<Vec<crate::db::ExecutionRow>> {
    let core = state.core.clone();
    blocking(move || core.db.executions(limit.unwrap_or(200))).await
}

// ───────────── 감시 / 상태 ─────────────

#[tauri::command]
pub async fn watch_set(state: State<'_, AppState>, worktrees: Vec<String>) -> Res<()> {
    let core = state.core.clone();
    let watcher = state.watcher.clone();
    // 감시 등록·무시 폴더 계산은 디스크를 읽으므로 async 실행 스레드를 막지 않게 따로 돌린다.
    blocking(move || {
        let worktrees: Vec<String> = worktrees.into_iter().filter(|w| core.is_known_worktree(w)).collect();
        let targets = core.watch_targets(&worktrees);
        if let Some(w) = watcher {
            w.set_targets(targets)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn kv_get(state: State<'_, AppState>, key: String) -> Res<Option<String>> {
    state.core.db.kv_get(&key).map_err(err)
}

#[tauri::command]
pub fn kv_set(state: State<'_, AppState>, key: String, value: String) -> Res<()> {
    state.core.db.kv_set(&key, &value).map_err(err)
}

/// 경로를 Finder 에서 보여 준다.
#[tauri::command]
pub fn reveal_in_finder(state: State<'_, AppState>, path: String) -> Res<()> {
    state.core.ensure_known(&path).map_err(err)?;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(tr!("경로가 없습니다: {path}", "Path not found: {path}"));
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// 테스트 자동화 응답 통로. `automation` 기능으로 빌드한 경우에만 동작한다.
#[tauri::command]
pub fn automation_reply(id: u64, ok: bool, value: String) -> Res<()> {
    #[cfg(feature = "automation")]
    {
        crate::automation::deliver(id, ok, value);
        Ok(())
    }
    #[cfg(not(feature = "automation"))]
    {
        let _ = (id, ok, value);
        Err("automation disabled".into())
    }
}

// ───────────── 실행 중 감지 ─────────────

#[tauri::command]
pub fn live_runs(state: State<'_, AppState>) -> Vec<crate::procs::LiveRun> {
    state.core.live_runs()
}

// ───────────── 채팅 ─────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStartArgs {
    pub agent: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub force: bool,
}

#[tauri::command]
pub async fn chat_start(state: State<'_, AppState>, args: ChatStartArgs) -> Res<crate::chat::ChatInfo> {
    let core = state.core.clone();
    blocking(move || {
        if let Some(c) = &args.cwd {
            if args.session_id.is_none() && !std::path::Path::new(c).is_dir() {
                anyhow::bail!(tr!("폴더가 없습니다: {c}", "Folder not found: {c}"));
            }
        }
        core.chat_start(&args.agent, args.session_id.as_deref(), args.cwd.as_deref(), &args.mode, args.force)
    })
    .await
}

#[tauri::command]
pub fn chat_attach(state: State<'_, AppState>, id: String, on_event: Channel<serde_json::Value>) -> Res<u64> {
    state
        .core
        .chats
        .attach(&id, Box::new(move |ev| on_event.send(serde_json::to_value(ev).unwrap_or_default()).is_ok()))
        .map_err(err)
}

#[tauri::command]
pub fn chat_detach(state: State<'_, AppState>, id: String, sink_id: u64) {
    state.core.chats.detach(&id, sink_id);
}

#[tauri::command]
pub async fn chat_send(app: tauri::AppHandle, state: State<'_, AppState>, id: String, text: String) -> Res<()> {
    use tauri::Emitter;
    let core = state.core.clone();
    blocking(move || {
        let app2 = app.clone();
        core.chats.send(&id, &text, std::sync::Arc::new(move |info| {
            let _ = app2.emit("chat-changed", info);
        }))
    })
    .await
}

#[tauri::command]
pub fn chat_permission(state: State<'_, AppState>, id: String, request_id: String, allow: bool) -> Res<()> {
    state.core.chats.respond_permission(&id, &request_id, allow).map_err(err)
}

#[tauri::command]
pub fn chat_interrupt(state: State<'_, AppState>, id: String) -> Res<()> {
    state.core.chats.interrupt(&id).map_err(err)
}

#[tauri::command]
pub fn chat_close(app: tauri::AppHandle, state: State<'_, AppState>, id: String) {
    use tauri::Emitter;
    state.core.chats.close(&id);
    let _ = app.emit("chat-changed", serde_json::json!({ "id": id, "closed": true }));
}

#[tauri::command]
pub fn chat_list(state: State<'_, AppState>) -> Vec<crate::chat::ChatInfo> {
    state.core.chats.list()
}

// ───────────── Git 쓰기 작업 (브랜치·워크트리·스테이징·병합) ─────────────

macro_rules! git_cmd {
    ($name:ident, ($($arg:ident : $ty:ty),*), $path:ident, $ret:ty, $body:expr) => {
        #[tauri::command]
        pub async fn $name(state: State<'_, AppState>, $($arg: $ty),*) -> Res<$ret> {
            let core = state.core.clone();
            blocking(move || {
                core.ensure_known(&$path)?;
                $body
            })
            .await
        }
    };
}

use crate::gitops;

git_cmd!(git_branch_create, (path: String, name: String, start: Option<String>, checkout: bool), path, String,
    gitops::create_branch(Path::new(&path), &name, start.as_deref(), checkout));
git_cmd!(git_branch_delete, (path: String, name: String, force: bool), path, String,
    gitops::delete_branch(Path::new(&path), &name, force));
git_cmd!(git_compare, (path: String, a: String, b: String), path, gitops::Compare,
    gitops::compare(Path::new(&path), &a, &b));
git_cmd!(git_worktree_add, (path: String, target: String, new_branch: Option<String>, base: Option<String>), path, String,
    gitops::worktree_add(Path::new(&path), &target, new_branch.as_deref(), base.as_deref()));
git_cmd!(git_worktree_prune, (path: String), path, String, gitops::worktree_prune(Path::new(&path)));
git_cmd!(git_diff_split, (path: String, rel: String), path, (Vec<FileDiff>, Vec<FileDiff>),
    gitops::diff_split(Path::new(&path), &rel));
git_cmd!(git_hunk, (path: String, rel: String, action: String, index: usize, hunk_id: String), path, (),
    gitops::apply_hunk(Path::new(&path), &rel, &action, index, &hunk_id));
git_cmd!(git_stage, (path: String, paths: Vec<String>), path, (), gitops::stage_paths(Path::new(&path), &paths));
git_cmd!(git_unstage, (path: String, paths: Vec<String>), path, (), gitops::unstage_paths(Path::new(&path), &paths));
git_cmd!(git_discard, (path: String, paths: Vec<String>), path, (), gitops::discard_paths(Path::new(&path), &paths));
git_cmd!(git_commit_staged, (path: String, message: String, amend: bool), path, String,
    gitops::commit_staged(Path::new(&path), &message, amend));
git_cmd!(git_merge, (path: String, target: String, mode: String), path, gitops::OpResult,
    gitops::merge(Path::new(&path), &target, &mode));
git_cmd!(git_rebase, (path: String, onto: String), path, gitops::OpResult, gitops::rebase(Path::new(&path), &onto));
git_cmd!(git_op_control, (path: String, action: String), path, gitops::OpResult, gitops::op_control(Path::new(&path), &action));
git_cmd!(git_resolve, (path: String, rel: String, side: String), path, (), gitops::resolve(Path::new(&path), &rel, &side));
git_cmd!(git_op_state, (path: String), path, gitops::OpState, gitops::op_state(Path::new(&path)));

/// 워크트리 삭제. 앱의 에이전트가 그 워크트리에서 돌고 있으면 막고, 외부 에이전트는 따로 확인(ignore_agents)받는다.
/// force 는 "커밋하지 않은 변경을 버림" 동의만 뜻한다.
#[tauri::command]
pub async fn git_worktree_remove(state: State<'_, AppState>, path: String, target: String, force: bool, ignore_agents: Option<bool>) -> Res<String> {
    let core = state.core.clone();
    blocking(move || {
        core.ensure_known(&path)?;
        if !Path::new(&target).exists() {
            anyhow::bail!(tr!("폴더가 이미 없는 워크트리입니다. '정리' 로 등록을 지우세요.", "This worktree's folder no longer exists. Use 'Prune' to remove its registration."));
        }
        core.ensure_known(&target)?;
        let canon = std::fs::canonicalize(&target)?;
        let inside = |p: &str| std::fs::canonicalize(p).map(|c| c.starts_with(&canon)).unwrap_or(false);
        let busy_exec = core.exec_list().into_iter().any(|e| !e.exited && inside(&e.cwd));
        let busy_chat = core.chats.list().into_iter().any(|c| c.alive && inside(&c.cwd));
        if busy_exec || busy_chat {
            anyhow::bail!(tr!("이 워크트리에서 앱의 에이전트가 실행 중입니다. 먼저 중지하세요.", "An agent started from this app is running in this worktree. Stop it first."));
        }
        core.refresh_live();
        let live = core.live_runs().into_iter().filter(|r| !r.owned_by_app && r.cwd.as_deref().is_some_and(inside)).count();
        if live > 0 && !ignore_agents.unwrap_or(false) {
            anyhow::bail!("EXTERNAL_AGENTS:{live}");
        }
        gitops::worktree_remove(Path::new(&path), &target, force)
    })
    .await
}
