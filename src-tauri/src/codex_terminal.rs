//! Codex terminal inside the app: the same per-turn engine as app chat, rendered in a PTY.
use crate::chat::{ChatEvent, ChatInfo, ChatManager, StartChat};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::sync::{
    Arc,
    atomic::{AtomicI32, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

pub const ARG: &str = "--codex-terminal";
static SIGNAL: AtomicI32 = AtomicI32::new(0);

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub cwd: String,
    pub resume_id: Option<String>,
    pub prompt: Option<String>,
    pub sandbox: String,
    pub english: bool,
}

extern "C" fn on_signal(sig: libc::c_int) {
    SIGNAL.store(sig, Ordering::Relaxed);
}

/// Runs before Tauri startup, without a second app window or a Python installation.
pub fn from_args() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next()?.as_str() != ARG {
        return None;
    }
    let result = (|| -> Result<()> {
        let config: Config =
            serde_json::from_str(&args.next().context("Missing terminal configuration")?)?;
        crate::i18n::set_english(config.english);
        // Only this helper process handles signals. Children get their own process groups.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_signal as *const () as usize;
            libc::sigemptyset(&mut action.sa_mask);
            for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
                if libc::sigaction(sig, &action, std::ptr::null_mut()) != 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
        }
        // Resolve the login environment before input starts; startup shells must not consume PTY input.
        let _ = crate::env::shell_env();
        unsafe {
            let mut term: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut term) == 0 {
                term.c_lflag |= libc::ICANON | libc::ECHO | libc::ISIG;
                term.c_iflag |= libc::ICRNL;
                term.c_iflag &= !(libc::IGNCR | libc::INLCR);
                term.c_oflag |= libc::OPOST | libc::ONLCR;
                term.c_cc[libc::VMIN] = 1;
                term.c_cc[libc::VTIME] = 0;
                if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &term) != 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
        }
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            loop {
                let mut line = String::new();
                match input.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        eprintln!("Terminal input: {e}");
                        break;
                    }
                }
            }
        });
        run(config, rx, &mut std::io::stdout())
    })();
    Some(match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Code Whereabouts: {error:#}");
            1
        }
    })
}

fn no_change() -> Arc<dyn Fn(&ChatInfo) + Send + Sync> {
    Arc::new(|_| {})
}

fn render(event: &ChatEvent, out: &mut impl Write) -> Result<()> {
    match event {
        ChatEvent::ModelSelected { route } => {
            let name = if route.model == "gpt-6-luna" {
                "GPT-6 Luna"
            } else {
                "GPT-6.1 Sol"
            };
            let effort = if route.effort == "medium" {
                "Medium"
            } else {
                "Low"
            };
            writeln!(
                out,
                "\n[{}] {name} {effort}",
                tr!("자동 선택", "Auto selected")
            )?;
        }
        ChatEvent::Assistant { text } => writeln!(out, "{text}")?,
        ChatEvent::Tool {
            name,
            summary,
            status,
            output,
            ..
        } => {
            if status == "running" {
                writeln!(out, "[{name}] {summary}")?;
            }
            if let Some(output) = output.as_deref().filter(|s| !s.is_empty()) {
                writeln!(out, "{output}")?;
            }
            if status == "error" {
                writeln!(out, "[{}] {summary}", tr!("도구 오류", "Tool error"))?;
            }
        }
        ChatEvent::FileChange { paths } => {
            for path in paths {
                writeln!(out, "[{}] {path}", tr!("변경", "Changed"))?;
            }
        }
        ChatEvent::Error { text } => writeln!(out, "[{}] {text}", tr!("오류", "Error"))?,
        ChatEvent::TurnEnd {
            is_error: true,
            text,
            ..
        } => writeln!(
            out,
            "[{}] {}",
            tr!(
                "요청 실패 · 같은 세션을 유지합니다",
                "Request failed; session retained"
            ),
            text.as_deref().unwrap_or("")
        )?,
        _ => {}
    }
    out.flush()?;
    Ok(())
}

fn turn(
    manager: &ChatManager,
    id: &str,
    prompt: &str,
    events: &mpsc::Receiver<ChatEvent>,
    out: &mut impl Write,
) -> Result<bool> {
    if let Err(error) = manager.send(id, prompt, no_change()) {
        writeln!(out, "[{}] {error}", tr!("시작 실패", "Start failed"))?;
    }
    let mut cancelled: Option<(Instant, Option<u32>)> = None;
    loop {
        let sig = SIGNAL.swap(0, Ordering::Relaxed);
        if sig == libc::SIGTERM || sig == libc::SIGHUP {
            return Ok(false);
        }
        if sig == libc::SIGINT {
            let pid = manager.get(id).and_then(|chat| chat.info().pid);
            let _ = manager.interrupt(id);
            cancelled.get_or_insert((Instant::now(), pid));
            writeln!(
                out,
                "\n{}",
                tr!("요청을 취소합니다…", "Cancelling request…")
            )?;
        }
        if let Some((at, Some(pid))) = cancelled {
            if at.elapsed() >= Duration::from_secs(5)
                && manager.get(id).is_some_and(|c| c.info().pid == Some(pid))
            {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                }
            }
        }
        match events.recv_timeout(Duration::from_millis(25)) {
            Ok(event) => render(&event, out)?,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let info = manager.get(id).context("Terminal session closed")?.info();
        // turn.completed can precede process exit. Wait for both before accepting another request.
        if !info.busy && info.pid.is_none() {
            while let Ok(event) = events.try_recv() {
                render(&event, out)?;
            }
            break;
        }
    }
    Ok(true)
}

fn help(out: &mut impl Write) -> Result<()> {
    writeln!(
        out,
        "{}",
        tr!(
            "Codex · 요청마다 모델 자동 선택 · 같은 대화로 이어갑니다",
            "Codex · Automatic model selection per request · Same conversation"
        )
    )?;
    writeln!(
        out,
        "{}",
        tr!(
            "요청 입력 후 Enter · /paste 여러 줄 · /status 세션 · /help 도움말 · /exit 종료",
            "Enter a request · /paste multiline · /status session · /help help · /exit quit"
        )
    )?;
    Ok(())
}

pub fn run(config: Config, input: mpsc::Receiver<String>, out: &mut impl Write) -> Result<()> {
    if !matches!(config.sandbox.as_str(), "read-only" | "workspace-write") {
        bail!("Invalid sandbox");
    }
    let manager = ChatManager::default();
    let info = manager.start(
        StartChat {
            agent: "codex".into(),
            resume_id: config.resume_id,
            cwd: config.cwd,
            mode: config.sandbox,
        },
        no_change(),
    )?;
    let (tx, events) = mpsc::channel();
    manager.attach(
        &info.id,
        Box::new(move |event| tx.send(event.clone()).is_ok()),
    )?;
    let result = (|| -> Result<()> {
        help(out)?;
        if let Some(prompt) = config.prompt.as_deref().filter(|s| !s.trim().is_empty()) {
            writeln!(out, "codewhere> {prompt}")?;
            if !turn(&manager, &info.id, prompt, &events, out)? {
                return Ok(());
            }
        }
        let mut paste: Option<Vec<String>> = None;
        let mut show_prompt = true;
        loop {
            if show_prompt {
                write!(
                    out,
                    "{}",
                    if paste.is_some() {
                        "... "
                    } else {
                        "codewhere> "
                    }
                )?;
                out.flush()?;
                show_prompt = false;
            }
            let sig = SIGNAL.swap(0, Ordering::Relaxed);
            if sig == libc::SIGTERM || sig == libc::SIGHUP {
                break;
            }
            if sig == libc::SIGINT {
                paste = None;
                writeln!(out)?;
                show_prompt = true;
            }
            let line = match input.recv_timeout(Duration::from_millis(25)) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            };
            show_prompt = true;
            let prompt = if let Some(lines) = paste.as_mut() {
                if line.trim_end_matches(['\r', '\n']) != "." {
                    lines.push(line.trim_end_matches(['\r', '\n']).to_string());
                    continue;
                }
                paste.take().unwrap().join("\n")
            } else {
                line.trim().to_string()
            };
            if prompt.is_empty() {
                continue;
            }
            match prompt.as_str() {
                "/exit" | "/quit" => break,
                "/help" => help(out)?,
                "/status" => {
                    let info = manager.get(&info.id).unwrap().info();
                    writeln!(out, "{}", info.session_id.as_deref().unwrap_or("new"))?;
                }
                "/paste" => {
                    paste = Some(Vec::new());
                }
                _ if prompt.starts_with('/') && !prompt.contains('\n') => writeln!(
                    out,
                    "{}",
                    tr!(
                        "모델은 자동 선택됩니다. 사용 가능한 명령은 /help에서 확인하세요.",
                        "Models are selected automatically. See /help for commands."
                    )
                )?,
                _ => {
                    if !turn(&manager, &info.id, &prompt, &events, out)? {
                        break;
                    }
                }
            }
        }
        Ok(())
    })();
    let chat = manager.get(&info.id);
    manager.close(&info.id);
    let deadline = Instant::now() + Duration::from_secs(2);
    while chat.as_ref().is_some_and(|c| c.info().pid.is_some()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture(
        resume: Option<&str>,
        sandbox: &str,
        prompts: &[&str],
    ) -> (String, Vec<serde_json::Value>) {
        let d = tempfile::tempdir().unwrap();
        let fake = d.path().join("codex");
        let log = d.path().join("calls");
        let script = format!(
            r#"#!/usr/bin/env python3
import json,sys
from pathlib import Path
p=sys.stdin.read()
a=sys.argv[1:]
sid=a[-2] if 'resume' in a else 'terminal-session'
with Path({log:?}).open('a') as f: f.write(json.dumps({{'args':a,'prompt':p,'sid':sid}})+'\n')
print(json.dumps({{'type':'thread.started','thread_id':sid}}))
print(json.dumps({{'type':'item.completed','item':{{'type':'agent_message','text':'reply:'+p}}}}))
if p=='FAIL':
 print(json.dumps({{'type':'turn.failed','error':{{'message':'Unavailable'}}}}))
 sys.exit(1)
print(json.dumps({{'type':'turn.completed'}}))
"#,
            log = log.to_string_lossy()
        );
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe {
            std::env::set_var("AITERM_CODEX_BIN", &fake);
        }
        let (tx, input) = mpsc::channel();
        for prompt in prompts {
            tx.send(format!("{prompt}\n")).unwrap();
        }
        drop(tx);
        let mut output = Vec::new();
        let result = run(
            Config {
                cwd: d.path().to_string_lossy().into_owned(),
                resume_id: resume.map(str::to_string),
                prompt: None,
                sandbox: sandbox.into(),
                english: false,
            },
            input,
            &mut output,
        );
        unsafe {
            std::env::remove_var("AITERM_CODEX_BIN");
        }
        result.unwrap();
        let calls = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        (String::from_utf8(output).unwrap(), calls)
    }

    #[test]
    fn terminal_routes_every_request_and_keeps_one_conversation() {
        let _guard = crate::env::TEST_ENV_LOCK.lock();
        let (output, calls) = fixture(
            None,
            "workspace-write",
            &[
                "git pull",
                "기능 추가",
                "동시성 버그",
                "계속해",
                "/status",
                "/exit",
            ],
        );
        assert_eq!(calls.len(), 4);
        for (i, (model, effort)) in [
            ("gpt-6-luna", "low"),
            ("gpt-6.1-sol", "low"),
            ("gpt-6.1-sol", "medium"),
            ("gpt-6.1-sol", "medium"),
        ]
        .into_iter()
        .enumerate()
        {
            let args = calls[i]["args"].as_array().unwrap();
            assert!(args.iter().any(|a| a == model), "{args:?}");
            assert!(
                args.iter()
                    .any(|a| a == &format!("model_reasoning_effort=\"{effort}\""))
            );
            assert_eq!(calls[i]["sid"], "terminal-session");
            assert_eq!(args.iter().any(|a| a == "resume"), i > 0);
        }
        assert!(
            output.contains("GPT-6 Luna Low")
                && output.contains("GPT-6.1 Sol Low")
                && output.matches("GPT-6.1 Sol Medium").count() == 2,
            "{output}"
        );
        assert!(output.contains("terminal-session"));
    }

    #[test]
    fn resume_permission_multiline_and_failure_keep_session() {
        let _guard = crate::env::TEST_ENV_LOCK.lock();
        let (output, calls) = fixture(
            Some("existing-session"),
            "read-only",
            &["FAIL", "/paste", "동시성", "오류 조사", ".", "/exit"],
        );
        assert_eq!(calls.len(), 2, "must not retry failed requests");
        assert!(output.contains("Unavailable"));
        assert_eq!(calls[1]["prompt"], "동시성\n오류 조사");
        for call in calls {
            assert_eq!(call["sid"], "existing-session");
            let args = call["args"].as_array().unwrap();
            assert!(args.iter().any(|a| a == "sandbox_mode=\"read-only\""));
            assert!(
                !args
                    .iter()
                    .any(|a| a.as_str().unwrap_or("").contains("bypass"))
            );
        }
    }
}
