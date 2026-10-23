#[macro_use]
pub mod i18n;
pub mod brand;
pub mod commands;
pub mod core;
pub mod db;
pub mod editors;
pub mod env;
pub mod extensions;
pub mod files;
pub mod git;
pub mod gitops;
pub mod graph;
pub mod handoff;
pub mod procs;
pub mod pty;
pub mod sessions;
pub mod watch;
pub mod updates;
pub mod usage;
#[cfg(feature = "automation")]
pub mod automation;

use std::sync::Arc;
use tauri::{Emitter, Manager};

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 파일 트리에서 Finder·다른 앱으로 끌어 내보내기(맥 네이티브 드래그). 창 안에 다시 놓으면 파일 드롭으로 돌아온다.
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdateState::default())
        .setup(|app| {
            // 로그인 셸 환경을 미리 읽어 둔다(첫 git 호출이 느려지지 않게).
            std::thread::spawn(|| {
                crate::env::shell_env();
            });

            // 앱 언어에 맞춘 이름·설정·업데이트 메뉴.
            #[cfg(target_os = "macos")]
            {
                app.set_menu(brand::menu(app.handle())?)?;
                app.on_menu_event(|app, e| {
                    if e.id() == "check-updates" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("check-updates", ());
                    }
                    if e.id() == "settings" {
                        let _ = app.emit("open-settings", ());
                    }
                });
            }

            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let db = db::Db::open(&data_dir.join("ai-terminal.sqlite3"))?;
            let h = handle.clone();
            let events: core::EventSink = Arc::new(move |name, payload| {
                let _ = h.emit(name, payload);
            });
            let core = core::AppCore::new(db, events);
            // 업데이트 전 버전이 맡겨 둔 에이전트(터미널)를 이어받는다
            match handoff::adopt(&core, &data_dir) {
                Ok(0) => {}
                Ok(n) => eprintln!("[handoff] 실행 중인 에이전트 {n}개를 이어받았습니다"),
                Err(e) => eprintln!("[handoff] 이어받지 못했습니다: {e:#}"),
            }

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

            // 실행 중 에이전트 감지: 창이 보일 때만 5초마다(숨겨져 있으면 CPU 를 쓰지 않음).
            {
                let core = core.clone();
                let h = handle.clone();
                std::thread::Builder::new().name("live-scan".into()).spawn(move || loop {
                    let visible = h
                        .get_webview_window("main")
                        .map(|w| w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false))
                        .unwrap_or(false);
                    if visible && core.refresh_live() {
                        let _ = h.emit("live-runs", core.live_runs());
                    }
                    std::thread::sleep(std::time::Duration::from_secs(if visible { 5 } else { 15 }));
                })?;
            }
            app.manage(AppState { core, watcher });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            usage::subscription_usage,
            updates::check_update,
            updates::install_update,
            updates::open_update_download,
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
            commands::fs_terminal_paths,
            commands::fs_copy_in,
            commands::fs_move,
            commands::set_lang,
            commands::fs_read_image,
            commands::fs_read_for_edit,
            commands::fs_save,
            commands::editors_installed,
            commands::open_in_editor,
            commands::extensions_list,
            commands::extension_set,
            commands::repo_probe,
            commands::repo_init,
            commands::git_edit_worktree,
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
            commands::live_runs,
            commands::git_branch_create,
            commands::git_branch_delete,
            commands::git_compare,
            commands::git_worktree_add,
            commands::git_worktree_remove,
            commands::git_worktree_prune,
            commands::git_diff_split,
            commands::git_hunk,
            commands::git_stage,
            commands::git_unstage,
            commands::git_discard,
            commands::git_commit_staged,
            commands::git_merge,
            commands::git_rebase,
            commands::git_op_control,
            commands::git_resolve,
            commands::git_op_state,
        ])
        .build(tauri::generate_context!())
        .expect("코드행방을 시작하지 못했습니다")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // 앱이 띄운 에이전트 프로세스를 남기지 않는다.
                if let Some(state) = app.try_state::<AppState>() {
                    state.core.pty.kill_all();
                }
            }
        });
}
