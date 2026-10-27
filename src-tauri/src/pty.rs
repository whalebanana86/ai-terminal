//! PTY 로 원본 CLI(claude, codex) 를 실행한다. 프로세스는 화면 전환과 무관하게 계속 돈다.

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::env::shell_env;

/// 실행 하나당 보관하는 출력 양 (다시 붙을 때 재생)
const SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;

pub type Sink = Box<dyn Fn(&[u8]) -> bool + Send>;
type OnExit = Box<dyn FnOnce(&str, Option<i32>) + Send>;

struct Inner {
    buffer: VecDeque<u8>,
    /// (구독 id, 전송 함수). 전송 실패하면 제거한다.
    sinks: Vec<(u64, Sink)>,
    exit_code: Option<i32>,
    exited: bool,
}

/// 끝난 실행을 화면 재생용으로 남겨 두는 개수
const KEEP_EXITED: usize = 8;

pub struct PtyExec {
    pub id: String,
    pub pid: Option<u32>,
    /// 끝나면 None 으로 바꿔 PTY 장치(fd)를 바로 돌려준다.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    started: std::time::Instant,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    inner: Mutex<Inner>,
    /// 끝났을 때 한 번 부른다. 업데이트로 넘기다 실패해 다시 읽기 시작해도 남아 있게 여기 둔다.
    on_exit: Mutex<Option<OnExit>>,
    /// 읽기 스레드를 멈추는 신호(파이프의 쓰는 쪽). 업데이트 때 PTY 를 새 앱에 넘기기 전에 쓴다.
    wake: Mutex<Option<OwnedFd>>,
    reader: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// 새 버전 앱으로 넘겼다: 이 앱이 꺼질 때 끝내지 않는다.
    handed_off: AtomicBool,
    /// 이전 버전 앱이 넘겨준 실행: 내 자식 프로세스가 아니라 종료 코드를 알 수 없다.
    adopted: bool,
}

/// 업데이트로 새 앱에 넘길 실행 하나: 화면 기록과 PTY 복제본(실행 파일을 띄울 때만 물려준다)
pub struct Handed {
    pub id: String,
    pub pid: Option<u32>,
    pub master: OwnedFd,
    pub buffer: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

/// 화면에 붙은 결과: 구독 id 와 먼저 재생한 출력 양(바이트)
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    pub sink_id: u64,
    pub replayed: usize,
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
            .ok_or_else(|| anyhow!(tr!("'{}' 명령을 찾을 수 없습니다. 설치되어 있고 로그인 셸 PATH 에 있는지 확인하세요.", "Command '{}' not found. Make sure it's installed and on your login shell PATH.", spec.program)))?;
        if !std::path::Path::new(&spec.cwd).is_dir() {
            return Err(anyhow!(tr!("작업 폴더가 없습니다: {}", "Working folder not found: {}", spec.cwd)));
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows: spec.rows.max(5), cols: spec.cols.max(20), pixel_width: 0, pixel_height: 0 })
            .with_context(|| tr!("PTY 를 열 수 없습니다", "Can't open a PTY"))?;
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
        let child = pair.slave.spawn_command(cmd).with_context(|| tr!("{} 실행 실패", "Failed to run {}", program.display()))?;
        drop(pair.slave);
        let pid = child.process_id();
        let writer = pair.master.take_writer()?;
        let exec = Arc::new(PtyExec {
            id: id.clone(),
            pid,
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            started: std::time::Instant::now(),
            child: Mutex::new(child),
            inner: Mutex::new(Inner { buffer: VecDeque::new(), sinks: Vec::new(), exit_code: None, exited: false }),
            on_exit: Mutex::new(Some(Box::new(on_exit))),
            wake: Mutex::new(None),
            reader: Mutex::new(None),
            handed_off: AtomicBool::new(false),
            adopted: false,
        });
        self.execs.lock().insert(id.clone(), exec.clone());
        start_reader(&exec)?;
        self.prune_exited();
        Ok(exec)
    }

    /// 이전 버전 앱이 업데이트하며 넘겨준 실행을 이어받는다. 화면 기록(buffer)은 넘기기 전까지의 출력.
    pub fn adopt(
        &self,
        id: String,
        pid: Option<u32>,
        master: OwnedFd,
        buffer: Vec<u8>,
        on_exit: impl FnOnce(&str, Option<i32>) + Send + 'static,
    ) -> Result<Arc<PtyExec>> {
        let master = AdoptedMaster { fd: master };
        let writer = master.take_writer()?;
        let mut buffer = VecDeque::from(buffer);
        let over = buffer.len().saturating_sub(SCROLLBACK_BYTES);
        buffer.drain(..over);
        let exec = Arc::new(PtyExec {
            id: id.clone(),
            pid,
            master: Mutex::new(Some(Box::new(master))),
            writer: Mutex::new(Some(writer)),
            started: std::time::Instant::now(),
            child: Mutex::new(Box::new(AdoptedChild { pid })),
            inner: Mutex::new(Inner { buffer, sinks: Vec::new(), exit_code: None, exited: false }),
            on_exit: Mutex::new(Some(Box::new(on_exit))),
            wake: Mutex::new(None),
            reader: Mutex::new(None),
            handed_off: AtomicBool::new(false),
            adopted: true,
        });
        self.execs.lock().insert(id.clone(), exec.clone());
        if let Err(e) = start_reader(&exec) {
            self.execs.lock().remove(&id);
            return Err(e);
        }
        Ok(exec)
    }

    /// 업데이트로 새 버전 앱에 넘길 실행들. 읽기 스레드를 멈추고(그 뒤 출력은 PTY 에 쌓여 기다린다)
    /// 화면 기록과 PTY 복제본을 돌려준다. 넘긴 실행은 이 앱이 꺼질 때 끝내지 않는다.
    /// 하나라도 멈출 수 없으면 다시 읽기 시작하고 오류를 낸다.
    pub fn detach_for_handoff(&self) -> Result<Vec<Handed>> {
        let running: Vec<Arc<PtyExec>> = self.execs.lock().values().filter(|e| !e.inner.lock().exited).cloned().collect();
        let mut out = Vec::new();
        for e in &running {
            let stopped = (|| -> Result<Option<Handed>> {
                let wake = e.wake.lock().take().ok_or_else(|| anyhow!(tr!("터미널 읽기를 멈출 수 없습니다", "Can't pause reading the terminal")))?;
                e.handed_off.store(true, Ordering::SeqCst);
                // SAFETY: 우리가 연 파이프에 한 바이트 쓴다.
                unsafe { libc::write(wake.as_raw_fd(), b"x".as_ptr().cast(), 1) };
                if let Some(h) = e.reader.lock().take() {
                    let _ = h.join();
                }
                let Some(fd) = e.master.lock().as_ref().and_then(|m| m.as_raw_fd()) else {
                    // 멈추는 사이에 에이전트가 끝나 읽기 스레드가 이미 정리했다: 넘길 것이 없다
                    e.handed_off.store(false, Ordering::SeqCst);
                    return Ok(None);
                };
                let inner = e.inner.lock();
                let (a, b) = inner.buffer.as_slices();
                Ok(Some(Handed { id: e.id.clone(), pid: e.pid, master: dup_cloexec(fd)?, buffer: [a, b].concat() }))
            })();
            match stopped {
                Ok(Some(h)) => out.push(h),
                Ok(None) => {}
                Err(err) => {
                    self.resume_handoff();
                    return Err(err);
                }
            }
        }
        Ok(out)
    }

    /// 넘기기를 그만두고 이 앱이 다시 읽는다(맡김 프로세스를 띄우지 못했을 때).
    pub fn resume_handoff(&self) {
        let list: Vec<Arc<PtyExec>> = self.execs.lock().values().filter(|e| e.handed_off.load(Ordering::SeqCst)).cloned().collect();
        for e in list {
            e.handed_off.store(false, Ordering::SeqCst);
            if let Err(err) = start_reader(&e) {
                eprintln!("[pty] {} 를 다시 읽지 못했습니다: {err:#}", e.id);
            }
        }
    }

    /// 끝난 실행은 최근 것 몇 개만 남긴다(출력 버퍼 메모리 회수).
    fn prune_exited(&self) {
        let mut execs = self.execs.lock();
        let mut exited: Vec<(String, std::time::Instant)> =
            execs.values().filter(|e| e.inner.lock().exited).map(|e| (e.id.clone(), e.started)).collect();
        if exited.len() <= KEEP_EXITED {
            return;
        }
        exited.sort_by_key(|(_, t)| *t);
        for (id, _) in exited.iter().take(exited.len() - KEEP_EXITED) {
            execs.remove(id);
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<PtyExec>> {
        self.execs.lock().get(id).cloned()
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        self.execs.lock().values().map(|e| e.info()).collect()
    }

    /// 지금까지의 출력을 먼저 보내고, 이후 출력을 계속 보낸다.
    pub fn attach(&self, id: &str, sink: Sink) -> Result<Attached> {
        let exec = self.get(id).ok_or_else(|| anyhow!(tr!("실행을 찾을 수 없습니다: {id}", "Run not found: {id}")))?;
        let sid = self.next_sink.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut inner = exec.inner.lock();
        // 버퍼 재생과 구독 등록을 같은 잠금 안에서 해야 출력이 빠지거나 겹치지 않는다.
        let (a, b) = inner.buffer.as_slices();
        let mut snapshot = Vec::with_capacity(a.len() + b.len());
        snapshot.extend_from_slice(a);
        snapshot.extend_from_slice(b);
        if !snapshot.is_empty() && !sink(&snapshot) {
            return Err(anyhow!(tr!("터미널 화면에 연결하지 못했습니다", "Failed to connect to the terminal view")));
        }
        inner.sinks.push((sid, sink));
        Ok(Attached { sink_id: sid, replayed: snapshot.len() })
    }

    pub fn detach(&self, id: &str, sink_id: u64) {
        if let Some(exec) = self.get(id) {
            exec.inner.lock().sinks.retain(|(s, _)| *s != sink_id);
        }
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let exec = self.get(id).ok_or_else(|| anyhow!(tr!("실행을 찾을 수 없습니다: {id}", "Run not found: {id}")))?;
        let mut w = exec.writer.lock();
        let w = w.as_mut().ok_or_else(|| anyhow!(tr!("이미 종료된 실행입니다", "This run has already ended")))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let exec = self.get(id).ok_or_else(|| anyhow!(tr!("실행을 찾을 수 없습니다: {id}", "Run not found: {id}")))?;
        if let Some(m) = exec.master.lock().as_ref() {
            m.resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })?;
        }
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let exec = self.get(id).ok_or_else(|| anyhow!(tr!("실행을 찾을 수 없습니다: {id}", "Run not found: {id}")))?;
        terminate(&exec);
        Ok(())
    }

    /// 끝난 실행을 목록에서 지운다.
    pub fn forget(&self, id: &str) {
        let mut execs = self.execs.lock();
        if execs.get(id).is_some_and(|e| e.inner.lock().exited) {
            execs.remove(id);
        }
    }

    /// 앱 종료 때: 모든 실행의 프로세스 그룹에 SIGHUP → 잠시 뒤 남은 것에 SIGKILL.
    pub fn kill_all(&self) {
        let list: Vec<Arc<PtyExec>> = self.execs.lock().values().cloned().collect();
        // 새 버전 앱에 넘긴 실행은 끝내지 않는다(맡김 프로세스가 PTY 를 쥐고 있다)
        let alive: Vec<Arc<PtyExec>> = list.into_iter().filter(|e| !e.inner.lock().exited && !e.handed_off.load(Ordering::SeqCst)).collect();
        for e in &alive {
            signal_group(e, libc::SIGHUP);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(800);
        while std::time::Instant::now() < deadline && alive.iter().any(|e| !e.inner.lock().exited) {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        for e in &alive {
            signal_group(e, libc::SIGKILL);
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

/// PTY 로 띄운 프로세스는 새 세션의 리더라 pid == 프로세스 그룹 id 다.
/// 그룹 전체에 보내야 에이전트가 띄운 셸·개발 서버 같은 자식까지 정리된다.
fn signal_group(exec: &PtyExec, sig: libc::c_int) {
    if let Some(pid) = exec.pid {
        // SAFETY: 단순 시스템 호출. 실패(이미 종료)는 무시한다.
        unsafe {
            libc::killpg(pid as libc::pid_t, sig);
        }
    }
}

/// 사용자 "중지": SIGHUP 을 보내고 1초 안에 안 끝나면 SIGKILL.
fn terminate(exec: &Arc<PtyExec>) {
    if exec.inner.lock().exited {
        return;
    }
    signal_group(exec, libc::SIGHUP);
    let e = exec.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        if !e.inner.lock().exited {
            signal_group(&e, libc::SIGKILL);
        }
    });
}

/// PTY 를 읽는 스레드를 띄운다. 프로세스가 끝나면 정리하고 on_exit 를 부른다.
/// 업데이트로 넘길 때는 wake 신호로 멈추고 아무것도 정리하지 않는다(새 앱이 이어서 읽는다).
fn start_reader(exec: &Arc<PtyExec>) -> Result<()> {
    let (reader, fd) = {
        let m = exec.master.lock();
        let m = m.as_ref().ok_or_else(|| anyhow!(tr!("터미널이 닫혔습니다", "The terminal is closed")))?;
        (m.try_clone_reader()?, m.as_raw_fd())
    };
    // select 로 기다릴 수 있으면 멈춤 신호를 단다(fd 번호가 FD_SETSIZE 를 넘으면 못 멈추고 넘기지도 못한다)
    let wake_read = match fd {
        Some(fd) if (fd as usize) < libc::FD_SETSIZE => {
            let (r, w) = pipe_cloexec()?;
            if (r.as_raw_fd() as usize) < libc::FD_SETSIZE {
                *exec.wake.lock() = Some(w);
                Some((fd, r))
            } else {
                None
            }
        }
        _ => None,
    };
    let e = exec.clone();
    let handle = std::thread::Builder::new().name(format!("pty-{}", exec.id)).spawn(move || {
        pump(reader, wake_read.as_ref().map(|(fd, r)| (*fd, r.as_raw_fd())), &e);
        if e.handed_off.load(Ordering::SeqCst) {
            return;
        }
        // 출력이 끝났다 = 프로세스 종료(또는 PTY 닫힘). 종료 코드를 기다린다.
        let code = if e.adopted {
            wait_gone(e.pid);
            None
        } else {
            e.child.lock().wait().ok().map(|s| s.exit_code() as i32)
        };
        {
            let mut inner = e.inner.lock();
            inner.exited = true;
            inner.exit_code = code;
            inner.sinks.clear();
        }
        // PTY 장치를 바로 반납한다(오래 켜 두어도 장치 한도에 걸리지 않게).
        e.writer.lock().take();
        e.master.lock().take();
        e.wake.lock().take();
        if let Some(f) = e.on_exit.lock().take() {
            f(&e.id, code);
        }
    })?;
    *exec.reader.lock() = Some(handle);
    Ok(())
}

/// `wake` = (PTY fd, 멈춤 신호 fd). 있으면 읽기 전에 select 로 둘 중 먼저 온 쪽을 본다.
/// macOS 의 poll·kqueue 는 PTY 같은 장치를 제대로 지원하지 않아 select 를 쓴다.
fn pump(mut reader: Box<dyn Read + Send>, wake: Option<(RawFd, RawFd)>, exec: &PtyExec) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if let Some((fd, stop)) = wake {
            match wait_readable(fd, stop) {
                Ok(true) | Err(_) => break,
                Ok(false) => {}
            }
        }
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

/// fd 를 읽을 수 있으면 false, 멈춤 신호가 오면 true.
fn wait_readable(fd: RawFd, stop: RawFd) -> std::io::Result<bool> {
    loop {
        // SAFETY: 두 fd 모두 FD_SETSIZE 보다 작다(start_reader 에서 확인). fd_set 은 0 으로 채워 시작한다.
        let (r, stopped) = unsafe {
            let mut set: libc::fd_set = std::mem::zeroed();
            libc::FD_ZERO(&mut set);
            libc::FD_SET(fd, &mut set);
            libc::FD_SET(stop, &mut set);
            let r = libc::select(fd.max(stop) + 1, &mut set, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
            (r, r > 0 && libc::FD_ISSET(stop, &set))
        };
        if r < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        return Ok(stopped);
    }
}

/// 다른 프로세스에 물려주지 않는 파이프 (읽는 쪽, 쓰는 쪽)
fn pipe_cloexec() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: fds 는 2칸. 성공하면 두 fd 를 소유한다.
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        for fd in fds {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        Ok((OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])))
    }
}

/// 다른 프로세스에 물려주지 않는 fd 복제본
pub fn dup_cloexec(fd: RawFd) -> std::io::Result<OwnedFd> {
    // SAFETY: 성공하면 새 fd 를 소유한다.
    let new = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if new < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(new) })
}

/// 넘겨받은 실행은 내 자식이 아니라 기다릴(waitpid) 수 없다. 프로세스가 사라질 때까지 잠깐 본다.
fn wait_gone(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    for _ in 0..40 {
        // SAFETY: 신호 0 은 존재 확인만 한다.
        let gone = unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        if gone {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// 넘겨받은 PTY 마스터. portable-pty 가 연 것이 아니라 fd 로 직접 다룬다.
struct AdoptedMaster {
    fd: OwnedFd,
}

impl MasterPty for AdoptedMaster {
    fn resize(&self, size: PtySize) -> Result<(), anyhow::Error> {
        let ws = libc::winsize { ws_row: size.rows, ws_col: size.cols, ws_xpixel: size.pixel_width, ws_ypixel: size.pixel_height };
        // SAFETY: 열린 PTY fd 와 올바른 winsize.
        if unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::TIOCSWINSZ, &ws) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    fn get_size(&self) -> Result<PtySize, anyhow::Error> {
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        // SAFETY: 열린 PTY fd 와 쓸 수 있는 winsize.
        if unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::TIOCGWINSZ, &mut ws) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(PtySize { rows: ws.ws_row, cols: ws.ws_col, pixel_width: ws.ws_xpixel, pixel_height: ws.ws_ypixel })
    }

    fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, anyhow::Error> {
        Ok(Box::new(std::fs::File::from(dup_cloexec(self.fd.as_raw_fd())?)))
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>, anyhow::Error> {
        Ok(Box::new(std::fs::File::from(dup_cloexec(self.fd.as_raw_fd())?)))
    }

    fn process_group_leader(&self) -> Option<libc::pid_t> {
        // SAFETY: 열린 PTY fd.
        let pg = unsafe { libc::tcgetpgrp(self.fd.as_raw_fd()) };
        (pg > 0).then_some(pg)
    }

    fn as_raw_fd(&self) -> Option<RawFd> {
        Some(self.fd.as_raw_fd())
    }

    fn tty_name(&self) -> Option<std::path::PathBuf> {
        None
    }
}

/// 넘겨받은 실행의 프로세스(내 자식이 아님)
#[derive(Debug, Clone, Copy)]
struct AdoptedChild {
    pid: Option<u32>,
}

impl Child for AdoptedChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        let Some(pid) = self.pid else { return Ok(Some(portable_pty::ExitStatus::with_exit_code(0))) };
        // SAFETY: 신호 0 은 존재 확인만 한다.
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        Ok((!alive).then(|| portable_pty::ExitStatus::with_exit_code(0)))
    }

    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        wait_gone(self.pid);
        Ok(portable_pty::ExitStatus::with_exit_code(0))
    }

    fn process_id(&self) -> Option<u32> {
        self.pid
    }
}

impl portable_pty::ChildKiller for AdoptedChild {
    fn kill(&mut self) -> std::io::Result<()> {
        if let Some(pid) = self.pid {
            // SAFETY: 단순 시스템 호출.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGHUP) };
        }
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(*self)
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
        let attached = m
            .attach("t1", Box::new(move |b| {
                s2.lock().extend_from_slice(b);
                true
            }))
            .unwrap();
        assert!(attached.replayed > 0, "앞선 출력 양을 알려 준다");
        m.write("t1", b"abc\r").unwrap();
        let code = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(code, Some(3));
        let text = String::from_utf8_lossy(&seen.lock()).into_owned();
        assert!(text.contains("hello 한글"), "{text}");
        assert!(text.contains("got:abc"), "{text}");
        assert!(m.get("t1").unwrap().info().exited);
    }

    #[test]
    fn kill_terminates_grandchildren_too() {
        let m = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        let marker = format!("aiterm-grandchild-{}", std::process::id());
        let exec = m
            .spawn(
                "t3".into(),
                SpawnSpec {
                    program: "/bin/sh".into(),
                    // 백그라운드 손자 프로세스(개발 서버 흉내)를 띄우고 기다린다
                    args: vec!["-c".into(), format!("(exec -a {marker} sleep 300) & wait")],
                    cwd: "/".into(),
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
        let pgid = exec.pid.unwrap();
        let before = std::process::Command::new("pgrep").args(["-g", &pgid.to_string()]).output().unwrap();
        let count = String::from_utf8_lossy(&before.stdout).lines().count();
        assert!(count >= 2, "shell + background grandchild must be running before kill (got {count})");
        m.kill("t3").unwrap();
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let out = std::process::Command::new("pgrep").args(["-g", &pgid.to_string()]).output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).trim().is_empty(), "process group must be gone");
        assert!(m.write("t3", b"x").is_err(), "writer is released after exit");
    }

    #[test]
    fn missing_program_is_reported() {
        // 다른 테스트가 메시지 언어를 잠깐 영어로 바꾸므로 같은 잠금을 잡는다
        let _g = crate::env::TEST_ENV_LOCK.lock();
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
