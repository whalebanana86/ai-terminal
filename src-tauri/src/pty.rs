//! PTY 로 원본 CLI(claude, codex) 를 실행한다. 프로세스는 화면 전환과 무관하게 계속 돈다.

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::Arc;

use crate::env::shell_env;

/// 실행 하나당 보관하는 출력 양 (다시 붙을 때 재생)
const SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;

pub type Sink = Box<dyn Fn(&[u8]) -> bool + Send>;

struct Inner {
    buffer: VecDeque<u8>,
    /// (구독 id, 전송 함수). 전송 실패하면 제거한다.
    sinks: Vec<(u64, Sink)>,
    exit_code: Option<i32>,
    exited: bool,
}

pub struct PtyExec {
    pub id: String,
    pub pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    inner: Mutex<Inner>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub extra_env: Vec<(String, String)>,
}

#[derive(Default)]
pub struct PtyManager {
    execs: Mutex<HashMap<String, Arc<PtyExec>>>,
    next_sink: std::sync::atomic::AtomicU64,
}

impl PtyManager {
    /// 실행을 시작한다. `on_exit(id, code)` 는 프로세스가 끝나고 출력이 다 읽힌 뒤 한 번 불린다.
    pub fn spawn(
        &self,
        id: String,
        spec: SpawnSpec,
        on_exit: impl FnOnce(&str, Option<i32>) + Send + 'static,
    ) -> Result<Arc<PtyExec>> {
        let program = crate::env::which(&spec.program)
            .ok_or_else(|| anyhow!("'{}' 명령을 찾을 수 없습니다. 설치되어 있고 로그인 셸 PATH 에 있는지 확인하세요.", spec.program))?;
        if !std::path::Path::new(&spec.cwd).is_dir() {
            return Err(anyhow!("작업 폴더가 없습니다: {}", spec.cwd));
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows: spec.rows.max(5), cols: spec.cols.max(20), pixel_width: 0, pixel_height: 0 })
            .context("PTY 를 열 수 없습니다")?;
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        cmd.env_clear();
        for (k, v) in shell_env() {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "AITerminal");
        cmd.env("PWD", &spec.cwd);
        for (k, v) in &spec.extra_env {
            cmd.env(k, v);
        }
        let child = pair.slave.spawn_command(cmd).with_context(|| format!("{} 실행 실패", program.display()))?;
        drop(pair.slave);
        let pid = child.process_id();
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let exec = Arc::new(PtyExec {
            id: id.clone(),
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            inner: Mutex::new(Inner { buffer: VecDeque::new(), sinks: Vec::new(), exit_code: None, exited: false }),
        });
        self.execs.lock().insert(id.clone(), exec.clone());

        let reader_exec = exec.clone();
        std::thread::Builder::new().name(format!("pty-{id}")).spawn(move || {
            pump(reader, &reader_exec);
            // 출력이 끝났다 = 프로세스 종료(또는 PTY 닫힘). 종료 코드를 기다린다.
            let code = reader_exec.child.lock().wait().ok().map(|s| s.exit_code() as i32);
            {
                let mut inner = reader_exec.inner.lock();
                inner.exited = true;
                inner.exit_code = code;
            }
            on_exit(&reader_exec.id, code);
        })?;
        Ok(exec)
    }

    pub fn get(&self, id: &str) -> Option<Arc<PtyExec>> {
        self.execs.lock().get(id).cloned()
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        self.execs.lock().values().map(|e| e.info()).collect()
    }

    /// 지금까지의 출력을 먼저 보내고, 이후 출력을 계속 보낸다. 반환값은 구독 id.
    pub fn attach(&self, id: &str, sink: Sink) -> Result<u64> {
        let exec = self.get(id).ok_or_else(|| anyhow!("실행을 찾을 수 없습니다: {id}"))?;
        let sid = self.next_sink.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut inner = exec.inner.lock();
        // 버퍼 재생과 구독 등록을 같은 잠금 안에서 해야 출력이 빠지거나 겹치지 않는다.
        let (a, b) = inner.buffer.as_slices();
        let mut snapshot = Vec::with_capacity(a.len() + b.len());
        snapshot.extend_from_slice(a);
        snapshot.extend_from_slice(b);
        if !snapshot.is_empty() && !sink(&snapshot) {
            return Err(anyhow!("터미널 화면에 연결하지 못했습니다"));
        }
        inner.sinks.push((sid, sink));
        Ok(sid)
    }

    pub fn detach(&self, id: &str, sink_id: u64) {
        if let Some(exec) = self.get(id) {
            exec.inner.lock().sinks.retain(|(s, _)| *s != sink_id);
        }
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let exec = self.get(id).ok_or_else(|| anyhow!("실행을 찾을 수 없습니다: {id}"))?;
        let mut w = exec.writer.lock();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let exec = self.get(id).ok_or_else(|| anyhow!("실행을 찾을 수 없습니다: {id}"))?;
        exec.master.lock().resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let exec = self.get(id).ok_or_else(|| anyhow!("실행을 찾을 수 없습니다: {id}"))?;
        if !exec.inner.lock().exited {
            exec.child.lock().kill()?;
        }
        Ok(())
    }

    /// 끝난 실행을 목록에서 지운다.
    pub fn forget(&self, id: &str) {
        let mut execs = self.execs.lock();
        if execs.get(id).is_some_and(|e| e.inner.lock().exited) {
            execs.remove(id);
        }
    }

    pub fn kill_all(&self) {
        for e in self.execs.lock().values() {
            if !e.inner.lock().exited {
                let _ = e.child.lock().kill();
            }
        }
    }

    pub fn output_text(&self, id: &str) -> Option<String> {
        let exec = self.get(id)?;
        let inner = exec.inner.lock();
        let (a, b) = inner.buffer.as_slices();
        let mut v = a.to_vec();
        v.extend_from_slice(b);
        Some(String::from_utf8_lossy(&v).into_owned())
    }
}

impl PtyExec {
    pub fn info(&self) -> PtyInfo {
        let inner = self.inner.lock();
        PtyInfo { id: self.id.clone(), pid: self.pid, exited: inner.exited, exit_code: inner.exit_code }
    }
}

fn pump(mut reader: Box<dyn Read + Send>, exec: &PtyExec) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let chunk = &buf[..n];
        let mut inner = exec.inner.lock();
        inner.buffer.extend(chunk);
        let over = inner.buffer.len().saturating_sub(SCROLLBACK_BYTES);
        if over > 0 {
            inner.buffer.drain(..over);
        }
        inner.sinks.retain(|(_, send)| send(chunk));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn spawn_attach_replay_and_exit() {
        let m = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        m.spawn(
            "t1".into(),
            SpawnSpec {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), "printf 'hello 한글\\n'; read x; printf \"got:$x\\n\"; exit 3".into()],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                extra_env: vec![],
            },
            move |_, code| {
                tx.send(code).unwrap();
            },
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        // 나중에 붙어도 앞선 출력이 재생된다
        let seen = Arc::new(Mutex::new(Vec::<u8>::new()));
        let s2 = seen.clone();
        m.attach("t1", Box::new(move |b| {
            s2.lock().extend_from_slice(b);
            true
        }))
        .unwrap();
        m.write("t1", b"abc\r").unwrap();
        let code = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(code, Some(3));
        let text = String::from_utf8_lossy(&seen.lock()).into_owned();
        assert!(text.contains("hello 한글"), "{text}");
        assert!(text.contains("got:abc"), "{text}");
        assert!(m.get("t1").unwrap().info().exited);
    }

    #[test]
    fn missing_program_is_reported() {
        let m = PtyManager::default();
        let err = m
            .spawn(
                "t2".into(),
                SpawnSpec { program: "definitely-not-a-cli-xyz".into(), args: vec![], cwd: "/".into(), cols: 80, rows: 24, extra_env: vec![] },
                |_, _| {},
            )
            .err()
            .unwrap();
        assert!(err.to_string().contains("찾을 수 없습니다"));
    }
}
