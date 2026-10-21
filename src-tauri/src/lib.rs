pub mod commands;
pub mod core;
pub mod db;
pub mod env;
pub mod files;
pub mod git;
pub mod graph;
pub mod pty;
pub mod sessions;
pub mod watch;
#[cfg(feature = "automation")]
pub mod automation;

use std::sync::Arc;
use tauri::{Emitter, Manager};

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 로그인 셸 환경을 미리 읽어 둔다(첫 git 호출이 느려지지 않게).
            std::thread::spawn(|| {
                crate::env::shell_env();
            });

            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let db = db::Db::open(&data_dir.join("ai-terminal.sqlite3"))?;
            let h = handle.clone();
            let events: core::EventSink = Arc::new(move |name, payload| {
                let _ = h.emit(name, payload);
            });
            let core = core::AppCore::new(db, events);

            let h = handle.clone();
            let watcher = watch::WorkspaceWatcher::new(Arc::new(move |batch| {
                let _ = h.emit("fs-changed", batch);
            }))
            .map_err(|e| eprintln!("[watch] 작업 폴더 감시를 시작하지 못했습니다: {e:#}"))
            .ok()
            .map(Arc::new);

            let h = handle.clone();
            match watch::SessionWatcher::new(
                sessions::claude_dir().join("projects"),
                sessions::codex_dir(),
                Arc::new(move |paths| {
                    let _ = h.emit("sessions-changed", paths);
                }),
            ) {
                // 앱이 살아 있는 동안 유지
                Ok(w) => {
                    app.manage(w);
                }
                Err(e) => eprintln!("[watch] 세션 기록 감시를 시작하지 못했습니다: {e:#}"),
            }

            #[cfg(feature = "automation")]
            automation::start(handle.clone());

            app.manage(AppState { core, watcher });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::repo_list,
            commands::repo_add,
            commands::repo_set_pinned,
            commands::git_worktrees,
            commands::git_graph,
            commands::git_status,
            commands::git_commit_detail,
            commands::git_diff_file,
            commands::git_diff_commit_file,
            commands::git_remotes,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::git_commit,
            commands::git_checkout,
            commands::fs_list,
            commands::fs_read,
            commands::sessions_list,
            commands::session_transcript,
            commands::exec_start,
            commands::exec_attach,
            commands::exec_detach,
            commands::exec_write,
            commands::exec_resize,
            commands::exec_kill,
            commands::exec_list,
            commands::exec_history,
            commands::watch_set,
            commands::kv_get,
            commands::kv_set,
            commands::reveal_in_finder,
            commands::automation_reply,
        ])
        .build(tauri::generate_context!())
        .expect("AI Terminal 을 시작하지 못했습니다")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // 앱이 띄운 에이전트 프로세스를 남기지 않는다.
                if let Some(state) = app.try_state::<AppState>() {
                    state.core.pty.kill_all();
                }
            }
        });
}
