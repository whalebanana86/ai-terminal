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
    pub watcher: Option<WorkspaceWatcher>,
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
pub async fn git_worktrees(path: String) -> Res<Vec<Worktree>> {
    blocking(move || git::worktrees(Path::new(&path))).await
}

// ───────────── Git 조회 ─────────────

#[tauri::command]
pub async fn git_graph(state: State<'_, AppState>, path: String, limit: Option<usize>) -> Res<GraphData> {
    let core = state.core.clone();
    blocking(move || core.graph(&path, limit.unwrap_or(1500).clamp(50, 20000))).await
}

#[tauri::command]
pub async fn git_status(path: String) -> Res<WorktreeStatus> {
    blocking(move || git::status(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_commit_detail(path: String, sha: String) -> Res<CommitDetail> {
    blocking(move || git::commit_detail(Path::new(&path), &sha)).await
}

#[tauri::command]
pub async fn git_diff_file(path: String, rel: String) -> Res<Vec<FileDiff>> {
    blocking(move || git::diff_worktree_file(Path::new(&path), &rel)).await
}

#[tauri::command]
pub async fn git_diff_commit_file(path: String, sha: String, rel: String) -> Res<Vec<FileDiff>> {
    blocking(move || git::diff_commit_file(Path::new(&path), &sha, &rel)).await
}

#[tauri::command]
pub async fn git_remotes(path: String) -> Res<Vec<String>> {
    blocking(move || git::remotes(Path::new(&path))).await
}

// ───────────── Git 쓰기 (UI 확인 후에만 호출) ─────────────

#[tauri::command]
pub async fn git_fetch(path: String) -> Res<String> {
    blocking(move || git::fetch(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_pull(path: String) -> Res<String> {
    blocking(move || git::pull_ff_only(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_push(path: String, set_upstream_remote: Option<String>) -> Res<String> {
    blocking(move || git::push(Path::new(&path), set_upstream_remote.as_deref())).await
}

#[tauri::command]
pub async fn git_commit(path: String, paths: Vec<String>, message: String) -> Res<String> {
    blocking(move || git::commit(Path::new(&path), &paths, &message)).await
}

#[tauri::command]
pub async fn git_checkout(path: String, target: String, kind: String) -> Res<String> {
    blocking(move || git::checkout(Path::new(&path), &target, &kind)).await
}

// ───────────── 파일 ─────────────

#[tauri::command]
pub async fn fs_list(worktree: String, rel: String) -> Res<Vec<DirEntry>> {
    blocking(move || crate::files::list_dir(Path::new(&worktree), &rel)).await
}

#[tauri::command]
pub async fn fs_read(worktree: String, rel: String) -> Res<FileContent> {
    blocking(move || crate::files::read_file(Path::new(&worktree), &rel)).await
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
    let targets = blocking(move || Ok(core.watch_targets(&worktrees))).await?;
    if let Some(w) = &state.watcher {
        w.set_targets(targets).map_err(err)?;
    }
    Ok(())
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
pub fn reveal_in_finder(path: String) -> Res<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("경로가 없습니다: {path}"));
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
