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
                if req.get("quit").and_then(|v| v.as_bool()) == Some(true) {
                    // ⌘Q 와 같은 정상 종료 경로(RunEvent::Exit)로 끝낸다.
                    let _ = writeln!(writer, "{}", serde_json::json!({ "ok": true, "value": "\"quitting\"" }));
                    app.exit(0);
                    return;
                }
                if req.get("handoffRestart").and_then(|v| v.as_bool()) == Some(true) {
                    // 업데이트 없이 '에이전트 맡기기 → 다시 시작' 만 해 본다(.app 묶음으로 실행했을 때)
                    let r = handoff_restart(&app);
                    let _ = writeln!(writer, "{}", serde_json::json!({ "ok": r.is_ok(), "value": serde_json::to_string(&r.clone().unwrap_or_else(|e| e)).unwrap_or_default() }));
                    if let Ok(n) = r.as_deref() {
                        eprintln!("[automation] 맡김 {n}, 다시 시작");
                        let app = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(200));
                            app.exit(0);
                        });
                    }
                    continue;
                }
                if let Some(f) = req.get("frame").and_then(|v| v.as_array()) {
                    // 스크린샷용: 창 위치·크기(포인트, 화면 왼쪽 위 기준) 맞추기
                    let n: Vec<f64> = f.iter().filter_map(|x| x.as_f64()).collect();
                    let ok = n.len() == 4 && set_frame(&app, n[0], n[1], n[2], n[3]);
                    let _ = writeln!(writer, "{}", serde_json::json!({ "ok": ok, "value": "null" }));
                    continue;
                }
                if let Some(keys) = req.get("keys").and_then(|v| v.as_array()) {
                    // [[keyCode, "글자"], ...] 를 진짜 키 입력처럼 창에 보낸다(입력기를 거침).
                    let delay = req.get("delayMs").and_then(|v| v.as_u64()).unwrap_or(60);
                    // [keyCode, "글자", "cmd"?] — 세 번째 값이 "cmd" 면 ⌘ 를 누른 채로(메뉴 단축키 시험용)
                    let keys: Vec<(u16, String)> = keys
                        .iter()
                        .filter_map(|k| {
                            let cmd = k.get(2).and_then(|v| v.as_str()) == Some("cmd");
                            Some((k.get(0)?.as_u64()? as u16 | if cmd { 0x8000 } else { 0 }, k.get(1)?.as_str()?.to_string()))
                        })
                        .collect();
                    let source = req.get("inputSource").and_then(|v| v.as_str()).map(str::to_string);
                    let ok = send_keys(&app, keys, delay, source);
                    let _ = writeln!(writer, "{}", serde_json::json!({ "ok": ok, "value": "null" }));
                    continue;
                }
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

fn set_frame(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> bool {
    let Some(win) = app.get_webview_window("main") else { return false };
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    win.set_size(tauri::LogicalSize::new(w, h)).is_ok()
}

/// 앱을 앞으로 가져와 키 이벤트를 NSApplication 으로 보낸다. 손쉬운 사용 권한 없이 자기 창에만 보낸다.
fn send_keys(app: &AppHandle, keys: Vec<(u16, String)>, delay_ms: u64, source: Option<String>) -> bool {
    let Some(win) = app.get_webview_window("main") else { return false };
    let Ok(ptr) = win.ns_window() else { return false };
    let ptr = ptr as usize;
    let (tx, rx) = mpsc::channel();
    let _ = app.run_on_main_thread(move || {
        use objc2_app_kit::{NSApplication, NSWindow};
        let mtm = objc2::MainThreadMarker::new().unwrap();
        let ns = NSApplication::sharedApplication(mtm);
        #[allow(deprecated)]
        ns.activateIgnoringOtherApps(true);
        let w: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        w.makeKeyAndOrderFront(None);
        // 이 앱의 입력 문맥에만 입력기를 지정한다(사용자 전체 입력 설정은 그대로).
        if let Some(src) = &source
            && let Some(ctx) = objc2_app_kit::NSTextInputContext::currentInputContext(mtm)
        {
            ctx.setSelectedKeyboardInputSource(Some(&objc2_foundation::NSString::from_str(src)));
            eprintln!("[automation] input source = {:?}", ctx.selectedKeyboardInputSource());
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(Duration::from_secs(2));
    std::thread::sleep(Duration::from_millis(300));
    for (code, chars) in keys {
        for down in [true, false] {
            let chars = chars.clone();
            let (tx, rx) = mpsc::channel();
            let _ = app.run_on_main_thread(move || {
                use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
                use objc2_foundation::{NSPoint, NSString};
                let mtm = objc2::MainThreadMarker::new().unwrap();
                let w: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
                let _ = (&chars, w, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(), NSEventType::KeyDown);
                // 실제 키보드와 같은 CGEvent 로 만든 뒤 NSEvent 로 감싸야 입력기(IMK)가 처리한다.
                let ev: Option<objc2::rc::Retained<NSEvent>> = unsafe {
                    let src = CGEventSourceCreate(1);
                    let cg = CGEventCreateKeyboardEvent(src, code & 0x7fff, down);
                    if code & 0x8000 != 0 {
                        CGEventSetFlags(cg, 1 << 20); // kCGEventFlagMaskCommand
                    }
                    let ev: Option<objc2::rc::Retained<NSEvent>> = objc2::msg_send![objc2::class!(NSEvent), eventWithCGEvent: cg];
                    CFRelease(cg);
                    if !src.is_null() {
                        CFRelease(src);
                    }
                    ev
                };
                let _ = NSString::from_str("");
                if let Some(ev) = ev {
                    NSApplication::sharedApplication(mtm).sendEvent(&ev);
                }
                let _ = tx.send(());
            });
            let _ = rx.recv_timeout(Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(if down { 15 } else { delay_ms }));
        }
    }
    true
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceCreate(state: i32) -> *mut std::ffi::c_void;
    fn CGEventCreateKeyboardEvent(source: *mut std::ffi::c_void, keycode: u16, keydown: bool) -> *mut std::ffi::c_void;
    fn CGEventSetFlags(event: *mut std::ffi::c_void, flags: u64);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *mut std::ffi::c_void);
}

/// 시험용: 에이전트를 맡기고, 1초 뒤 같은 .app 을 다시 띄우게 해 둔다(시험 환경변수를 넘겨서).
fn handoff_restart(app: &AppHandle) -> Result<String, String> {
    use std::os::unix::process::CommandExt;
    let state = app.state::<crate::commands::AppState>();
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let n = crate::handoff::prepare(&state.core, &data_dir).map_err(|e| format!("{e:#}"))?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe.ancestors().nth(3).filter(|p| p.extension().is_some_and(|x| x == "app")).ok_or("앱 묶음(.app)으로 실행해야 합니다")?.to_path_buf();
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.arg("-c").arg("sleep 1; exec /usr/bin/open -n \"$@\"").arg("sh");
    for k in ["AITERM_AUTOMATION_SOCKET", "AITERM_HOME", "AITERM_CLAUDE_BIN", "AITERM_CODEX_BIN", "SIZE_LOG"] {
        if let Ok(v) = std::env::var(k) {
            cmd.arg("--env").arg(format!("{k}={v}"));
        }
    }
    cmd.arg(bundle);
    // SAFETY: fork 뒤 setsid 만 부른다.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(n.to_string())
}
