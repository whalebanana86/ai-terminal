//! 업데이트할 때 터미널에서 실행 중인 에이전트를 끝내지 않고 새 버전 앱으로 넘긴다.
//!
//! 1. 옛 앱: 업데이트를 설치한 뒤 PTY 를 읽던 스레드를 멈추고, 화면 기록과 실행 정보를 `handoff/` 폴더에 쓴다.
//! 2. 옛 앱: 같은 실행 파일(설치했으니 이제 새 버전)을 `--handoff-keeper <폴더>` 로 띄워 PTY(마스터 fd) 복제본을 물려준다.
//!    맡김 프로세스가 PTY 를 쥐고 있는 동안에는 옛 앱이 꺼져도 에이전트에 끊김(SIGHUP)이 가지 않는다.
//! 3. 맡김 프로세스: 그사이 나온 출력을 받아 두다가, 새 앱이 소켓에 붙으면 fd 를 SCM_RIGHTS 로 넘기고 끝난다.
//! 4. 새 앱: 시작할 때 소켓이 있으면 받아서 같은 실행 id 로 이어서 연다(화면 기록 = 옛 기록 + 그사이 출력).
//!
//! 옛 앱이 쓴 manifest.json 을 새 버전 맡김 프로세스·새 앱이 읽는다. 형식을 바꿀 때는 이전 형식도 읽을 수 있어야 한다(v).

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::core::{AppCore, ExecInfo};
use crate::pty::Handed;

const VERSION: u32 = 1;
const KEEPER_ARG: &str = "--handoff-keeper";
const SOCKET: &str = "keeper.sock";
const MANIFEST: &str = "manifest.json";
/// 새 앱이 이 시간 안에 붙지 않으면 맡김 프로세스가 끝난다(그러면 에이전트도 끝난다).
const KEEP_FOR: Duration = Duration::from_secs(10 * 60);
/// 맡아 두는 동안 받은 출력은 실행마다 이만큼만(앱의 화면 기록과 같은 양)
const MAX_HELD: usize = 2 * 1024 * 1024;
/// 맡김 폴더의 파일·소켓 줄을 읽을 때의 상한(앱이 쓰는 것보다 넉넉히)
const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_LINE: u64 = 64;

/// 이어받기에 실패했을 때 화면에 한 번 알릴 말(앱이 뜨기 전에 일어나 이벤트로는 놓친다)
static NOTICE: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);

pub fn take_notice() -> Option<String> {
    NOTICE.lock().take()
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    v: u32,
    execs: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    #[serde(flatten)]
    info: ExecInfo,
    /// 맡김 프로세스에서의 PTY fd 번호(물려줄 때 번호가 그대로다)
    fd: RawFd,
}

/// 맡김 프로세스가 새 앱에 fd 와 함께 보내는 답. fd 는 ids 순서.
#[derive(Serialize, Deserialize)]
struct Taken {
    v: u32,
    ids: Vec<String>,
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("handoff")
}

/// 실행 id 는 파일 이름에 쓰므로 uuid 꼴만 받는다
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn read_capped(path: &Path) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    std::fs::File::open(path)?.take(MAX_FILE + 1).read_to_end(&mut out)?;
    if out.len() as u64 > MAX_FILE {
        bail!("맡김 파일이 너무 큽니다: {}", path.display());
    }
    Ok(out)
}

/// 붙은 상대가 이 앱(같은 Contents/MacOS 폴더의 실행 파일)인지. 같은 사용자의 다른 프로그램이
/// 업데이트 순간에 먼저 붙어 에이전트 터미널을 가져가지 못하게 한다.
/// 실행 파일 이름이 버전마다 바뀌어도 넘길 수 있게 폴더로 비교한다.
fn peer_is_this_app(stream: &UnixStream) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: 연결된 유닉스 소켓, pid_t 크기의 버퍼.
    let ok = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&raw mut pid).cast(), &mut len) } == 0;
    if !ok || pid <= 0 {
        return false;
    }
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: buf 길이를 그대로 넘긴다.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return false;
    }
    let peer = Path::new(std::ffi::OsStr::from_bytes(&buf[..n as usize])).to_path_buf();
    let folder = |p: &Path| std::fs::canonicalize(p).ok().and_then(|p| p.parent().map(Path::to_path_buf));
    match (std::env::current_exe().ok().and_then(|p| folder(&p)), folder(&peer)) {
        (Some(mine), Some(theirs)) => mine == theirs,
        _ => false,
    }
}

// ───────────── 옛 앱: 맡기기 ─────────────

/// 터미널에서 실행 중인 에이전트를 맡김 프로세스에 맡긴다. 맡긴 수를 돌려준다(없으면 0).
/// 실패하면 이 앱이 다시 읽기 시작하고 오류를 돌려준다(에이전트는 그대로 돈다).
pub fn prepare(core: &AppCore, data_dir: &Path) -> Result<usize> {
    let handed = core.pty.detach_for_handoff()?;
    if handed.is_empty() {
        return Ok(0);
    }
    spawn_keeper(core, data_dir, handed).inspect_err(|_| core.pty.resume_handoff())
}

fn spawn_keeper(core: &AppCore, data_dir: &Path, handed: Vec<Handed>) -> Result<usize> {
    let dir = dir(data_dir);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let infos = core.exec_list();
    let mut execs = Vec::new();
    for h in &handed {
        let info = infos.iter().find(|e| e.id == h.id).cloned().ok_or_else(|| anyhow!("실행 정보가 없습니다: {}", h.id))?;
        std::fs::write(dir.join(format!("{}.out", h.id)), &h.buffer)?;
        execs.push(Entry { info, fd: h.master.as_raw_fd() });
    }
    std::fs::write(dir.join(MANIFEST), serde_json::to_vec(&Manifest { v: VERSION, execs })?)?;

    let fds: Vec<RawFd> = handed.iter().map(|h| h.master.as_raw_fd()).collect();
    let mut cmd = std::process::Command::new(std::env::current_exe()?);
    cmd.arg(KEEPER_ARG).arg(&dir).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    // SAFETY: fork 뒤 exec 전에 비동기 신호 안전 함수(setsid, fcntl)만 부른다.
    unsafe {
        cmd.pre_exec(move || {
            // 앱과 다른 세션으로(앱이 꺼져도 함께 끝나지 않게), PTY 복제본만 물려준다
            libc::setsid();
            for fd in &fds {
                libc::fcntl(*fd, libc::F_SETFD, 0);
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().context("맡김 프로세스를 띄우지 못했습니다")?;
    let n = handed.len();
    drop(handed); // 복제본은 맡김 프로세스가 가졌다
    let sock = dir.join(SOCKET);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !sock.exists() {
        if let Ok(Some(status)) = child.try_wait() {
            bail!("맡김 프로세스가 바로 끝났습니다({status})");
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("맡김 프로세스가 준비되지 않았습니다");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // 끝나기를 기다리지 않는다(이 앱이 먼저 꺼지고, 거두는 건 launchd 가 한다).
    Ok(n)
}

// ───────────── 맡김 프로세스 ─────────────

/// `ai-terminal --handoff-keeper <폴더>` 로 실행됐으면 맡김 프로세스로 돌고 종료 코드를 돌려준다.
pub fn keeper_from_args() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next()? != KEEPER_ARG {
        return None;
    }
    let dir = PathBuf::from(args.next()?);
    Some(match keep(&dir) {
        Ok(()) => 0,
        Err(e) => {
            let _ = std::fs::write(dir.join("keeper.log"), format!("{e:#}\n"));
            1
        }
    })
}

struct Held {
    id: String,
    fd: OwnedFd,
    out: Vec<u8>,
    /// 읽기가 끝났다(에이전트가 끝남). fd 는 그대로 넘겨 새 앱이 끝난 것으로 표시하게 한다.
    eof: bool,
}

fn keep(dir: &Path) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(&read_capped(&dir.join(MANIFEST))?)?;
    if let Some(e) = manifest.execs.iter().find(|e| !safe_id(&e.info.id)) {
        bail!("올바르지 않은 실행 id: {:?}", e.info.id);
    }
    let mut held: Vec<Held> = manifest
        .execs
        .into_iter()
        .map(|e| {
            // 더 넘기지 않게 다시 닫힘 표시를 단다.
            // SAFETY: 띄운 앱이 이 번호로 물려줬다.
            unsafe { libc::fcntl(e.fd, libc::F_SETFD, libc::FD_CLOEXEC) };
            Held { id: e.info.id, fd: unsafe { OwnedFd::from_raw_fd(e.fd) }, out: Vec::new(), eof: false }
        })
        .collect();
    let sock = dir.join(SOCKET);
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;
    std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))?;
    let deadline = Instant::now() + KEEP_FOR;
    while Instant::now() < deadline {
        let ready = select(listener.as_raw_fd(), &held, Some(Duration::from_secs(1)))?;
        drain(&mut held, &ready);
        if ready.contains(&listener.as_raw_fd())
            && let Ok((stream, _)) = listener.accept()
        {
            match serve(dir, &stream, &mut held) {
                Ok(Served::Taken) => {
                    let _ = std::fs::remove_file(&sock);
                    return Ok(());
                }
                // 보냈지만 받았다는 답이 없다: 새 앱이 이미 읽고 있을 수 있으니 더는 읽지 않고 쥐고만 있는다
                // (둘이 나눠 읽으면 출력이 빠진다). 다시 take 가 오면 그대로 다시 보낸다.
                Ok(Served::Sent) => held.iter_mut().for_each(|h| h.eof = true),
                Ok(Served::No) | Err(_) => {}
            }
        }
    }
    let _ = std::fs::remove_file(&sock);
    bail!("새 앱이 {}분 안에 붙지 않았습니다", KEEP_FOR.as_secs() / 60)
}

/// 읽을 수 있는 fd 들. PTY 는 select 로만 기다릴 수 있다(macOS 의 poll·kqueue 는 장치를 제대로 지원하지 않는다).
fn select(listener: RawFd, held: &[Held], timeout: Option<Duration>) -> Result<Vec<RawFd>> {
    let fds: Vec<RawFd> = std::iter::once(listener)
        .chain(held.iter().filter(|h| !h.eof).map(|h| h.fd.as_raw_fd()))
        .filter(|&fd| (fd as usize) < libc::FD_SETSIZE)
        .collect();
    let mut tv = timeout.map(|t| libc::timeval { tv_sec: t.as_secs() as _, tv_usec: t.subsec_micros() as _ });
    // SAFETY: 모든 fd 가 FD_SETSIZE 보다 작다. fd_set 은 0 으로 채워 시작한다.
    unsafe {
        let mut set: libc::fd_set = std::mem::zeroed();
        libc::FD_ZERO(&mut set);
        for &fd in &fds {
            libc::FD_SET(fd, &mut set);
        }
        let max = fds.iter().copied().max().unwrap_or(0);
        let tvp = tv.as_mut().map_or(std::ptr::null_mut(), |t| t as *mut _);
        let r = libc::select(max + 1, &mut set, std::ptr::null_mut(), std::ptr::null_mut(), tvp);
        if r < 0 {
            let err = std::io::Error::last_os_error();
            return if err.kind() == std::io::ErrorKind::Interrupted { Ok(Vec::new()) } else { Err(err.into()) };
        }
        Ok(fds.into_iter().filter(|&fd| libc::FD_ISSET(fd, &set)).collect())
    }
}

/// select 가 읽을 수 있다고 한 PTY 를 한 번씩 읽어 둔다(막히지 않는다).
fn drain(held: &mut [Held], ready: &[RawFd]) {
    let mut buf = vec![0u8; 64 * 1024];
    for h in held.iter_mut().filter(|h| !h.eof && ready.contains(&h.fd.as_raw_fd())) {
        // SAFETY: 열린 fd 와 buf 길이.
        let n = unsafe { libc::read(h.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 {
            h.eof = true;
            continue;
        }
        h.out.extend_from_slice(&buf[..n as usize]);
        let over = h.out.len().saturating_sub(MAX_HELD);
        h.out.drain(..over);
    }
}

enum Served {
    /// 넘기지 않았다(다른 사용자·다른 프로그램·잘못된 요청)
    No,
    /// fd 를 보냈지만 받았다는 답은 못 받았다
    Sent,
    /// 보냈고 받았다는 답까지 받았다
    Taken,
}

/// 새 앱에 넘긴다.
fn serve(dir: &Path, stream: &UnixStream, held: &mut [Held]) -> Result<Served> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    // 같은 사용자의 이 앱만
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: 연결된 유닉스 소켓.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != unsafe { libc::getuid() } || !peer_is_this_app(stream) {
        return Ok(Served::No);
    }
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    (&mut reader).take(MAX_LINE).read_line(&mut line)?;
    if line.trim() != "take" {
        return Ok(Served::No);
    }
    // 마지막으로 쌓인 출력까지 받아 둔다(이 뒤 출력은 새 앱이 읽는다)
    loop {
        let ready = select(-1, held, Some(Duration::ZERO))?;
        if ready.is_empty() {
            break;
        }
        drain(held, &ready);
    }
    for h in held.iter() {
        std::fs::write(dir.join(format!("{}.more", h.id)), &h.out)?;
    }
    let mut msg = serde_json::to_vec(&Taken { v: VERSION, ids: held.iter().map(|h| h.id.clone()).collect() })?;
    msg.push(b'\n');
    let fds: Vec<RawFd> = held.iter().map(|h| h.fd.as_raw_fd()).collect();
    send_fds(stream, &msg, &fds)?;
    // 받았다는 답을 기다린다(받기 전에 끝나면 fd 가 닫혀 에이전트가 끝난다)
    let mut ack = String::new();
    let _ = (&mut reader).take(MAX_LINE).read_line(&mut ack);
    Ok(if ack.trim() == "ok" { Served::Taken } else { Served::Sent })
}

fn send_fds(stream: &UnixStream, data: &[u8], fds: &[RawFd]) -> Result<()> {
    let bytes = std::mem::size_of_val(fds);
    // SAFETY: msghdr·cmsg 버퍼를 CMSG_* 계산대로 잡고 채운다.
    let sent = unsafe {
        let space = libc::CMSG_SPACE(bytes as u32) as usize;
        let mut cbuf = vec![0u8; space];
        let mut iov = libc::iovec { iov_base: data.as_ptr() as *mut _, iov_len: data.len() };
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cbuf.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN(bytes as u32) as _;
        std::ptr::copy_nonoverlapping(fds.as_ptr(), libc::CMSG_DATA(cmsg).cast::<RawFd>(), fds.len());
        libc::sendmsg(stream.as_raw_fd(), &msg, 0)
    };
    if sent < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // 글이 다 안 갔으면 나머지(fd 는 첫 조각에 붙어 갔다)
    (&*stream).write_all(&data[sent as usize..])?;
    Ok(())
}

// ───────────── 새 앱: 이어받기 ─────────────

/// 시작할 때: 이전 버전 앱이 맡겨 둔 에이전트가 있으면 이어받는다. 이어받은 수를 돌려준다.
/// 이어받지 못한 것이 있으면 화면에 알릴 말을 남긴다(take_notice).
pub fn adopt(core: &Arc<AppCore>, data_dir: &Path) -> Result<usize> {
    let dir = dir(data_dir);
    if !dir.exists() {
        return Ok(0);
    }
    if !dir.join(SOCKET).exists() {
        // 맡김 프로세스가 기다리다 끝났다(그러면서 에이전트도 끝났다)
        if dir.join("keeper.log").exists() {
            *NOTICE.lock() = Some(tr!(
                "업데이트 전에 실행 중이던 에이전트를 새 버전이 {m}분 안에 이어받지 못해 에이전트가 끝났습니다.",
                "The new version didn't pick up the agents that were running before the update within {m} minutes, so they ended.",
                m = KEEP_FOR.as_secs() / 60
            ));
        }
        let _ = std::fs::remove_dir_all(&dir);
        return Ok(0);
    }
    let result = take(core, &dir);
    match &result {
        Ok((_, 0)) => {}
        Ok((_, failed)) => {
            *NOTICE.lock() = Some(tr!(
                "업데이트 전에 실행 중이던 에이전트 {failed}개를 새 버전에서 이어받지 못해 끝났습니다.",
                "{failed} agent(s) that were running before the update couldn't be picked up by the new version and ended."
            ))
        }
        Err(e) => {
            // 맡김 프로세스가 아직 살아 있으면 폴더를 남겨 앱을 다시 열 때 한 번 더 받는다
            let alive = UnixStream::connect(dir.join(SOCKET)).is_ok();
            *NOTICE.lock() = Some(if alive {
                tr!(
                    "업데이트 전에 실행 중이던 에이전트를 이어받지 못했습니다({e:#}). 에이전트는 아직 돌고 있으니 {m}분 안에 앱을 다시 열어 주세요.",
                    "Couldn't pick up the agents that were running before the update ({e:#}). They are still running; reopen the app within {m} minutes.",
                    m = KEEP_FOR.as_secs() / 60
                )
            } else {
                tr!(
                    "업데이트 전에 실행 중이던 에이전트를 이어받지 못했습니다({e:#}).",
                    "Couldn't pick up the agents that were running before the update ({e:#})."
                )
            });
            if alive {
                return result.map(|(n, _)| n);
            }
        }
    }
    // 받았든 못 받았든(맡김 프로세스가 이미 끝남 등) 남은 파일은 지운다
    let _ = std::fs::remove_dir_all(&dir);
    result.map(|(n, _)| n)
}

/// 이어받은 수와 못 받은 수
fn take(core: &Arc<AppCore>, dir: &Path) -> Result<(usize, usize)> {
    let sock = dir.join(SOCKET);
    let manifest: Manifest = serde_json::from_slice(&read_capped(&dir.join(MANIFEST))?)?;
    if manifest.v > VERSION {
        bail!("모르는 맡김 형식입니다(v{})", manifest.v);
    }
    let stream = UnixStream::connect(&sock).context("맡김 프로세스에 붙지 못했습니다")?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    (&stream).write_all(b"take\n")?;
    let (mut data, fds) = recv_fds(&stream, manifest.execs.len())?;
    while !data.ends_with(b"\n") {
        if data.len() as u64 > MAX_FILE {
            bail!("맡김 프로세스의 답이 너무 깁니다");
        }
        let mut more = [0u8; 4096];
        let n = (&stream).read(&mut more)?;
        if n == 0 {
            bail!("맡김 프로세스의 답이 끊겼습니다");
        }
        data.extend_from_slice(&more[..n]);
    }
    let taken: Taken = serde_json::from_slice(&data)?;
    if taken.ids.len() != fds.len() {
        bail!("받은 터미널 수가 맞지 않습니다({} / {})", fds.len(), taken.ids.len());
    }
    let (mut n, mut failed) = (0, 0);
    for (id, fd) in taken.ids.into_iter().zip(fds) {
        let Some(entry) = manifest.execs.iter().find(|e| e.info.id == id && safe_id(&id)) else {
            failed += 1;
            continue;
        };
        let mut buffer = read_capped(&dir.join(format!("{id}.out"))).unwrap_or_default();
        buffer.extend(read_capped(&dir.join(format!("{id}.more"))).unwrap_or_default());
        match core.adopt_exec(entry.info.clone(), fd, buffer) {
            Ok(()) => n += 1,
            Err(e) => {
                eprintln!("[handoff] {id} 를 이어받지 못했습니다: {e:#}");
                failed += 1;
            }
        }
    }
    (&stream).write_all(b"ok\n")?;
    Ok((n, failed))
}

fn recv_fds(stream: &UnixStream, expect: usize) -> Result<(Vec<u8>, Vec<OwnedFd>)> {
    let mut buf = vec![0u8; 64 * 1024];
    // 혹시 더 와도 잘리지 않게 넉넉히
    let space = unsafe { libc::CMSG_SPACE((std::mem::size_of::<RawFd>() * (expect + 8)) as u32) } as usize;
    let mut cbuf = vec![0u8; space];
    let mut fds = Vec::new();
    // SAFETY: msghdr·cmsg 버퍼를 CMSG_* 계산대로 잡고, 커널이 채운 SCM_RIGHTS 만 읽는다.
    let n = unsafe {
        let mut iov = libc::iovec { iov_base: buf.as_mut_ptr().cast(), iov_len: buf.len() };
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cbuf.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        let n = libc::recvmsg(stream.as_raw_fd(), &mut msg, 0);
        if n < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                let count = ((*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize) / std::mem::size_of::<RawFd>();
                let data = libc::CMSG_DATA(cmsg).cast::<RawFd>();
                for i in 0..count {
                    let fd = std::ptr::read_unaligned(data.add(i));
                    libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                    fds.push(OwnedFd::from_raw_fd(fd));
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
        if msg.msg_flags & libc::MSG_CTRUNC != 0 {
            bail!("받은 터미널 목록이 잘렸습니다");
        }
        n as usize
    };
    buf.truncate(n);
    Ok((buf, fds))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::pty::{PtyManager, SpawnSpec};
    use std::os::fd::IntoRawFd;

    fn wait_for(f: impl Fn() -> bool) -> bool {
        for _ in 0..100 {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn hand_over_running_terminal_and_keep_output_in_order() {
        let dir = std::env::temp_dir().join(format!("aiterm-handoff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 옛 앱: 입력을 받아 그대로 돌려주는 셸
        let old = PtyManager::default();
        let script = "echo start; while IFS= read -r l; do echo got:$l; done";
        old.spawn(
            "t1".into(),
            SpawnSpec { program: "sh".into(), args: vec!["-c".into(), script.into()], cwd: "/".into(), cols: 80, rows: 24, extra_env: vec![] },
            |_, _| {},
        )
        .unwrap();
        old.write("t1", b"one\r").unwrap();
        assert!(wait_for(|| old.output_text("t1").unwrap().contains("got:one")));

        // 맡긴다: 읽기를 멈추고 기록·PTY 복제본을 받는다
        let handed = old.detach_for_handoff().unwrap();
        assert_eq!(handed.len(), 1);
        let h = handed.into_iter().next().unwrap();
        let info = ExecInfo {
            id: h.id.clone(),
            session_id: None,
            agent: "claude".into(),
            kind: "new".into(),
            cwd: "/".into(),
            worktree_path: None,
            branch_at_start: None,
            head_at_start: None,
            started_at: 1,
            pid: h.pid,
            exited: false,
            exit_code: None,
        };
        std::fs::write(dir.join("t1.out"), &h.buffer).unwrap();
        let fd = h.master.into_raw_fd();
        std::fs::write(dir.join(MANIFEST), serde_json::to_vec(&Manifest { v: VERSION, execs: vec![Entry { info, fd }] }).unwrap()).unwrap();
        // 옛 앱이 꺼지면 이 앱의 PTY 는 닫히지만, 여기서는 같은 프로세스라 그대로 두고 맡김 쪽만 본다
        let keeper_dir = dir.clone();
        let keeper = std::thread::spawn(move || keep(&keeper_dir));
        assert!(wait_for(|| dir.join(SOCKET).exists()));

        // 맡아 두는 동안 나온 출력은 맡김 프로세스가 받아 둔다(옛 앱은 더 읽지 않는다)
        old.write("t1", b"two\r").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(!old.output_text("t1").unwrap().contains("got:two"));

        // 같은 사용자라도 이 앱이 아닌 프로그램이 먼저 붙어 take 를 보내면 넘기지 않는다
        let mut nc = std::process::Command::new("/usr/bin/nc")
            .args(["-w", "3", "-U"])
            .arg(dir.join(SOCKET))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        nc.stdin.take().unwrap().write_all(b"take\n").unwrap();
        let got = nc.wait_with_output().unwrap();
        assert!(got.stdout.is_empty(), "{:?}", String::from_utf8_lossy(&got.stdout));

        // 새 앱: 이어받는다
        let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
        assert_eq!(take(&core, &dir).unwrap(), (1, 0));
        keeper.join().unwrap().unwrap();
        let out = core.pty.output_text("t1").unwrap();
        let (a, b) = (out.find("got:one").unwrap(), out.find("got:two").expect(&out));
        assert!(a < b, "{out}");
        assert!(core.exec_list().iter().any(|e| e.id == "t1" && !e.exited));

        // 이어받은 뒤 입력·크기 바꾸기도 된다
        core.pty.write("t1", b"three\r").unwrap();
        assert!(wait_for(|| core.pty.output_text("t1").unwrap().contains("got:three")));
        core.pty.resize("t1", 100, 30).unwrap();
        core.pty.kill("t1").unwrap();
        assert!(wait_for(|| core.exec_list().iter().any(|e| e.id == "t1" && e.exited)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
