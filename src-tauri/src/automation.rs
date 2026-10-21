//! E2E 테스트용 원격 조작 소켓 (`--features automation` 빌드에서만 포함).
//!
//! `AITERM_AUTOMATION_SOCKET` 경로의 유닉스 소켓에 한 줄짜리 JSON `{"js": "..."}` 를 보내면
//! 앱 화면(WebView)에서 그 JS 를 실행하고 `{"ok": bool, "value": "..."}` 를 한 줄로 돌려준다.
//! 배포 빌드에는 들어가지 않으며, 환경변수를 지정하지 않으면 소켓도 열지 않는다.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

static PENDING: OnceLock<Mutex<HashMap<u64, mpsc::Sender<(bool, String)>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<u64, mpsc::Sender<(bool, String)>>> {
    PENDING.get_or_init(Default::default)
}

pub fn deliver(id: u64, ok: bool, value: String) {
    if let Some(tx) = pending().lock().remove(&id) {
        let _ = tx.send((ok, value));
    }
}

pub fn start(app: AppHandle) {
    let Ok(path) = std::env::var("AITERM_AUTOMATION_SOCKET") else { return };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[automation] 소켓을 열 수 없습니다: {e}");
            return;
        }
    };
    eprintln!("[automation] listening on {path}");
    std::thread::spawn(move || {
        let mut next = 1u64;
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut writer = stream;
            let mut line = String::new();
            while reader.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                let req: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or_default();
                line.clear();
                let js = req.get("js").and_then(|v| v.as_str()).unwrap_or("null").to_string();
                let timeout = req.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(30_000);
                let id = next;
                next += 1;
                let (tx, rx) = mpsc::channel();
                pending().lock().insert(id, tx);
                let wrapped = format!(
                    "(async () => {{ const __id = {id}; try {{ const __v = await (async () => {{ {js} }})(); \
                     await window.__TAURI_INTERNALS__.invoke('automation_reply', {{ id: __id, ok: true, value: JSON.stringify(__v === undefined ? null : __v) }}); }} \
                     catch (e) {{ await window.__TAURI_INTERNALS__.invoke('automation_reply', {{ id: __id, ok: false, value: String(e && e.stack || e) }}); }} }})();"
                );
                let resp = match app.get_webview_window("main") {
                    Some(w) => match w.eval(&wrapped) {
                        Ok(()) => rx.recv_timeout(Duration::from_millis(timeout)).unwrap_or((false, "timeout".into())),
                        Err(e) => (false, e.to_string()),
                    },
                    None => (false, "no main window".into()),
                };
                pending().lock().remove(&id);
                if !resp.0 && resp.1 == "timeout" {
                    eprintln!("[automation] 응답 없음(문법 오류였을 수 있음): {}", js.chars().take(300).collect::<String>());
                }
                let out = serde_json::json!({ "ok": resp.0, "value": resp.1 });
                if writeln!(writer, "{out}").is_err() {
                    break;
                }
            }
        }
    });
}
