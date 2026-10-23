//! Actual app executable in a PTY, with a fake Codex. No inference or app window.
use ai_terminal_lib::{
    codex_terminal::{ARG, Config},
    pty::{PtyManager, SpawnSpec},
};
use std::{
    os::unix::fs::PermissionsExt,
    sync::mpsc,
    time::{Duration, Instant},
};

struct Cleanup(PtyManager);
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.kill_all();
    }
}

fn wait_for(pty: &PtyManager, expected: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let text = pty.output_text("router").unwrap_or_default();
        if text.contains(expected) && text.ends_with("codewhere> ") {
            return text;
        }
        assert!(Instant::now() < deadline, "Missing {expected:?}: {text}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn app_terminal_accepts_followups_cancels_and_resumes_in_one_session() {
    let temp = tempfile::tempdir().unwrap();
    let fake = temp.path().join("codex");
    let calls = temp.path().join("calls");
    std::fs::write(&fake, format!(r#"#!/usr/bin/env python3
import json,sys,time
from pathlib import Path
p=sys.stdin.read();a=sys.argv[1:]
sid=a[-2] if 'resume' in a else 'pty-session'
with Path({calls:?}).open('a') as f: f.write(json.dumps({{'args':a,'prompt':p,'sid':sid}})+'\n')
print(json.dumps({{'type':'thread.started','thread_id':sid}}),flush=True)
if p=='WAIT_CANCEL': time.sleep(30)
print(json.dumps({{'type':'item.completed','item':{{'type':'agent_message','text':'REPLY:'+p}}}}),flush=True)
print(json.dumps({{'type':'turn.completed'}}),flush=True)
"#, calls=calls.to_string_lossy())).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config = Config {
        cwd: temp.path().to_string_lossy().into_owned(),
        resume_id: None,
        prompt: Some("git pull".into()),
        sandbox: "read-only".into(),
        english: true,
    };
    let guard = Cleanup(PtyManager::default());
    let pty = &guard.0;
    let (tx, exited) = mpsc::channel();
    pty.spawn(
        "router".into(),
        SpawnSpec {
            program: env!("CARGO_BIN_EXE_ai-terminal").into(),
            args: vec![ARG.into(), serde_json::to_string(&config).unwrap()],
            cwd: config.cwd.clone(),
            cols: 100,
            rows: 30,
            extra_env: vec![(
                "AITERM_CODEX_BIN".into(),
                fake.to_string_lossy().into_owned(),
            )],
        },
        move |_, code| {
            let _ = tx.send(code);
        },
    )
    .unwrap();
    let output = wait_for(pty, "REPLY:git pull");
    assert!(output.contains("GPT-6 Luna Low"));
    for (prompt, model) in [
        ("기능 추가", "GPT-6.1 Sol Low"),
        ("동시성 버그", "GPT-6.1 Sol Medium"),
        ("계속해", "GPT-6.1 Sol Medium"),
    ] {
        pty.write("router", format!("{prompt}\r").as_bytes())
            .unwrap();
        let output = wait_for(pty, &format!("REPLY:{prompt}"));
        assert!(output.contains(model), "{output}");
    }
    pty.write("router", b"WAIT_CANCEL\r").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while std::fs::read_to_string(&calls).unwrap().lines().count() < 5 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    pty.write("router", b"\x03").unwrap();
    wait_for(pty, "Cancelling request");
    pty.write("router", "문구 수정\r".as_bytes()).unwrap();
    wait_for(pty, "REPLY:문구 수정");
    pty.write("router", b"/exit\r").unwrap();
    assert_eq!(
        exited.recv_timeout(Duration::from_secs(3)).unwrap(),
        Some(0)
    );
    let calls: Vec<serde_json::Value> = std::fs::read_to_string(calls)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(calls.len(), 6);
    for (i, call) in calls.iter().enumerate() {
        assert_eq!(call["sid"], "pty-session");
        let args = call["args"].as_array().unwrap();
        assert_eq!(args.iter().any(|a| a == "resume"), i > 0);
        assert!(
            args.iter()
                .any(|a| a == "read-only" || a == "sandbox_mode=\"read-only\"")
        );
    }
}
