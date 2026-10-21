//! 지금 실행 중인 에이전트 프로세스를 세션과 짝짓는다(외부 터미널·다른 앱에서 연 세션 감지).
//!
//! - Claude Code: 실행 중인 프로세스마다 `~/.claude/sessions/<pid>.json` 에 세션 id·cwd·상태를 적는다.
//!   pid 가 재사용되었을 수 있으므로 프로세스 시작 시각과 기록의 startedAt 을 대조한다.
//! - Codex: 대화를 쓰는 프로세스가 `~/.codex/thread-writer-locks/<thread>.lock` 을 열어 잡고 있다.
//!   `lsof` 로 잡고 있는 pid 를 찾는다.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::sessions::{claude_dir, codex_dir, is_safe_session_id};

#[derive(Debug, Clone, PartialEq)]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    /// 시작 시각(유닉스 밀리초, 초 단위 정밀도)
    pub start_ms: i64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRun {
    /// `claude:<id>` / `codex:<id>`
    pub session_id: String,
    pub agent: String,
    pub pid: u32,
    /// cli | sdk | desktop | app-server | vscode ...
    pub client: String,
    /// Claude 가 기록한 상태(idle/busy 등)
    pub status: Option<String>,
    pub cwd: Option<String>,
    pub started_at: i64,
    /// 이 앱이 띄운 프로세스(또는 그 자손)인지
    pub owned_by_app: bool,
}

/// `[[dd-]hh:]mm:ss` → 초
pub fn parse_etime(s: &str) -> Option<i64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<i64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<i64> = rest.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let secs = match parts.as_slice() {
        [m, s] => m * 60 + s,
        [h, m, s] => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(days * 86400 + secs)
}

pub fn parse_ps(raw: &str, now_ms: i64) -> Vec<ProcInfo> {
    raw.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let et = parse_etime(it.next()?)?;
            let command = it.collect::<Vec<_>>().join(" ");
            Some(ProcInfo { pid, ppid, start_ms: now_ms - et * 1000, command })
        })
        .collect()
}

/// 실행 중 프로세스 목록. 외부 프로그램(ps)을 띄우지 않고 커널(libproc)에서 바로 읽는다(수 ms).
pub fn list_procs() -> Vec<ProcInfo> {
    libproc::all_pids()
        .into_iter()
        .filter_map(|pid| {
            let info = libproc::bsd_info(pid)?;
            // 실행 파일 경로(없으면 프로세스 이름)를 command 로 쓴다. 판별은 claude/codex 포함 여부뿐이다.
            let command = libproc::pid_path(pid).unwrap_or_else(|| libproc::cstr(&info.pbi_name));
            Some(ProcInfo {
                pid: pid as u32,
                ppid: info.pbi_ppid,
                start_ms: info.pbi_start_tvsec as i64 * 1000 + info.pbi_start_tvusec as i64 / 1000,
                command,
            })
        })
        .collect()
}

/// macOS libproc 얇은 래퍼
mod libproc {
    use std::ffi::c_int;

    pub fn all_pids() -> Vec<c_int> {
        // SAFETY: 크기를 먼저 묻고 그만큼(여유 포함) 버퍼를 준다.
        unsafe {
            let n = libc::proc_listallpids(std::ptr::null_mut(), 0);
            if n <= 0 {
                return Vec::new();
            }
            let mut buf: Vec<c_int> = vec![0; n as usize + 64];
            let got = libc::proc_listallpids(buf.as_mut_ptr().cast(), (buf.len() * std::mem::size_of::<c_int>()) as c_int);
            if got <= 0 {
                return Vec::new();
            }
            buf.truncate(got as usize);
            buf.retain(|p| *p > 0);
            buf
        }
    }

    pub fn bsd_info(pid: c_int) -> Option<libc::proc_bsdinfo> {
        // SAFETY: 구조체 크기만큼 버퍼를 주고, 돌아온 크기가 정확히 같을 때만 쓴다.
        unsafe {
            let mut info: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as c_int;
            let n = libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size);
            (n == size).then_some(info)
        }
    }

    pub fn pid_path(pid: c_int) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: 버퍼 크기를 정확히 넘긴다.
        let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
    }

    /// 프로세스의 현재 작업 폴더
    pub fn cwd(pid: c_int) -> Option<String> {
        // SAFETY: 구조체 크기만큼 버퍼를 주고 반환 크기를 확인한다.
        unsafe {
            let mut vi: libc::proc_vnodepathinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as c_int;
            let n = libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut vi as *mut libc::proc_vnodepathinfo).cast(), size);
            if n != size {
                return None;
            }
            let flat: &[std::ffi::c_char] = std::slice::from_raw_parts(vi.pvi_cdir.vip_path.as_ptr().cast(), 1024);
            let s = cstr(flat);
            (!s.is_empty()).then_some(s)
        }
    }

    pub fn cstr(chars: &[std::ffi::c_char]) -> String {
        let bytes: Vec<u8> = chars.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[repr(C)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }

    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        pvip: libc::vnode_info_path,
    }

    const PROC_PIDFDVNODEPATHINFO: c_int = 2;

    /// 프로세스가 열어 둔 파일 경로들
    pub fn open_files(pid: c_int) -> Vec<String> {
        let mut out = Vec::new();
        // SAFETY: 각 호출에 정확한 버퍼 크기를 넘기고, 반환 크기를 확인한다.
        unsafe {
            let need = libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0);
            if need <= 0 {
                return out;
            }
            let cap = need as usize / std::mem::size_of::<libc::proc_fdinfo>() + 16;
            let mut fds: Vec<libc::proc_fdinfo> = Vec::with_capacity(cap);
            let got = libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                (cap * std::mem::size_of::<libc::proc_fdinfo>()) as c_int,
            );
            if got <= 0 {
                return out;
            }
            fds.set_len(got as usize / std::mem::size_of::<libc::proc_fdinfo>());
            for fd in fds.iter().filter(|f| f.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32) {
                let mut vi: VnodeFdInfoWithPath = std::mem::zeroed();
                let size = std::mem::size_of::<VnodeFdInfoWithPath>() as c_int;
                let n = libc::proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDVNODEPATHINFO, (&mut vi as *mut VnodeFdInfoWithPath).cast(), size);
                if n != size {
                    continue;
                }
                let flat: &[std::ffi::c_char] = std::slice::from_raw_parts(vi.pvip.vip_path.as_ptr().cast(), 1024);
                out.push(cstr(flat));
            }
        }
        out
    }
}

/// pid 가 roots 중 하나이거나 그 자손인지
pub fn descends_from(pid: u32, roots: &HashSet<u32>, parent: &HashMap<u32, u32>) -> bool {
    let mut cur = pid;
    for _ in 0..64 {
        if roots.contains(&cur) {
            return true;
        }
        match parent.get(&cur) {
            Some(&p) if p > 1 && p != cur => cur = p,
            _ => return false,
        }
    }
    false
}

fn client_of(command: &str, entrypoint: Option<&str>) -> String {
    if let Some(e) = entrypoint {
        return match e {
            "cli" => "cli".into(),
            e if e.starts_with("sdk") => "sdk".into(),
            other => other.into(),
        };
    }
    if command.contains("ChatGPT.app") || command.contains("Codex.app") {
        "desktop".into()
    } else if command.contains("app-server") {
        "app-server".into()
    } else if command.contains("vscode") || command.contains("Code Helper") {
        "vscode".into()
    } else {
        "cli".into()
    }
}

/// Claude: ~/.claude/sessions/<pid>.json 들을 실행 중 프로세스와 대조
pub fn claude_runs(procs: &HashMap<u32, ProcInfo>, dir: &std::path::Path) -> Vec<LiveRun> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let (Some(pid), Some(sid)) = (v.get("pid").and_then(Value::as_u64), v.get("sessionId").and_then(Value::as_str)) else { continue };
        let pid = pid as u32;
        let Some(proc_) = procs.get(&pid) else { continue }; // 끝난 프로세스의 남은 파일
        if !proc_.command.contains("claude") || !is_safe_session_id(sid) {
            continue;
        }
        let started = v.get("startedAt").and_then(Value::as_i64).unwrap_or(0);
        // pid 재사용 방지: 프로세스 시작 직후에 등록한 기록이어야 한다.
        if started > 0 && (started - proc_.start_ms).abs() > 5 * 60_000 {
            continue;
        }
        out.push(LiveRun {
            session_id: format!("claude:{sid}"),
            agent: "claude".into(),
            pid,
            client: client_of(&proc_.command, v.get("entrypoint").and_then(Value::as_str)),
            status: v.get("status").and_then(Value::as_str).map(str::to_string),
            cwd: v.get("cwd").and_then(Value::as_str).map(str::to_string),
            started_at: if started > 0 { started } else { proc_.start_ms },
            owned_by_app: false,
        });
    }
    out
}

/// `lsof -F pn` 출력 → (pid, thread id)
pub fn parse_lsof_locks(raw: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut pid = None;
    for line in raw.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse::<u32>().ok();
        } else if let Some(n) = line.strip_prefix('n') {
            let name = std::path::Path::new(n).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            if let (Some(pid), Some(id)) = (pid, name.strip_suffix(".lock")) {
                if !id.starts_with('.') && is_safe_session_id(id) {
                    out.push((pid, id.to_string()));
                }
            }
        }
    }
    out
}

pub fn codex_runs(procs: &HashMap<u32, ProcInfo>, lock_dir: &std::path::Path) -> Vec<LiveRun> {
    if !lock_dir.is_dir() {
        return Vec::new();
    }
    // codex 프로세스들이 열어 둔 파일 중 잠금 폴더 안의 것 = 그 프로세스가 쓰고 있는 대화
    let dir = std::fs::canonicalize(lock_dir).unwrap_or_else(|_| lock_dir.to_path_buf());
    let mut pairs: Vec<(u32, String)> = Vec::new();
    for p in procs.values().filter(|p| p.command.contains("codex") || p.command.contains("Codex")) {
        for f in libproc::open_files(p.pid as std::ffi::c_int) {
            let path = std::path::Path::new(&f);
            if path.parent() != Some(dir.as_path()) && path.parent() != Some(lock_dir) {
                continue;
            }
            if let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".lock")) {
                if !id.starts_with('.') && is_safe_session_id(id) {
                    pairs.push((p.pid, id.to_string()));
                }
            }
        }
    }
    pairs
        .into_iter()
        .filter_map(|(pid, id)| {
            let p = procs.get(&pid)?;
            Some(LiveRun {
                session_id: format!("codex:{id}"),
                agent: "codex".into(),
                pid,
                client: client_of(&p.command, None),
                status: None,
                // 데스크톱 앱 서버는 작업 폴더가 대화 폴더와 무관하다
                cwd: if p.command.contains(".app/") { None } else { libproc::cwd(pid as std::ffi::c_int) },
                started_at: p.start_ms,
                owned_by_app: false,
            })
        })
        .collect()
}

/// 지금 실행 중인 에이전트 세션 전체. app_pids 는 이 앱이 띄운 실행들의 pid.
pub fn scan(app_pids: &HashSet<u32>) -> Vec<LiveRun> {
    let procs: HashMap<u32, ProcInfo> = list_procs().into_iter().map(|p| (p.pid, p)).collect();
    let parent: HashMap<u32, u32> = procs.values().map(|p| (p.pid, p.ppid)).collect();
    let mut runs = claude_runs(&procs, &claude_dir().join("sessions"));
    runs.extend(codex_runs(&procs, &codex_dir().join("thread-writer-locks")));
    for r in &mut runs {
        r.owned_by_app = descends_from(r.pid, app_pids, &parent);
    }
    runs.sort_by(|a, b| a.session_id.cmp(&b.session_id).then(a.pid.cmp(&b.pid)));
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etime_and_ps_parsing() {
        assert_eq!(parse_etime("05:07"), Some(307));
        assert_eq!(parse_etime("01:00:00"), Some(3600));
        assert_eq!(parse_etime("2-03:04:05"), Some(2 * 86400 + 3 * 3600 + 4 * 60 + 5));
        let p = parse_ps("  123   1      01:00 /usr/bin/claude --resume abc\n", 1_000_000);
        assert_eq!(p[0].pid, 123);
        assert_eq!(p[0].start_ms, 1_000_000 - 60_000);
        assert_eq!(p[0].command, "/usr/bin/claude --resume abc");
    }

    #[test]
    fn claude_registry_matches_live_process_only() {
        let d = tempfile::tempdir().unwrap();
        let now = 10_000_000_000;
        std::fs::write(d.path().join("100.json"), format!(r#"{{"pid":100,"sessionId":"s-live","cwd":"/r","startedAt":{},"status":"busy","entrypoint":"cli"}}"#, now - 59_000)).unwrap();
        std::fs::write(d.path().join("200.json"), format!(r#"{{"pid":200,"sessionId":"s-dead","startedAt":{}}}"#, now)).unwrap();
        // pid 300 은 재사용됨: 기록은 하루 전, 프로세스는 방금 시작
        std::fs::write(d.path().join("300.json"), format!(r#"{{"pid":300,"sessionId":"s-reused","startedAt":{}}}"#, now - 86_400_000)).unwrap();
        let procs: HashMap<u32, ProcInfo> = [
            ProcInfo { pid: 100, ppid: 1, start_ms: now - 60_000, command: "claude".into() },
            ProcInfo { pid: 300, ppid: 1, start_ms: now - 1_000, command: "claude".into() },
        ]
        .into_iter()
        .map(|p| (p.pid, p))
        .collect();
        let runs = claude_runs(&procs, d.path());
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].session_id, "claude:s-live");
        assert_eq!(runs[0].status.as_deref(), Some("busy"));
        assert_eq!(runs[0].client, "cli");
    }

    #[test]
    fn lsof_lock_parsing_and_descendants() {
        let raw = "p76051\nf42\nn/Users/x/.codex/thread-writer-locks/01a1-b2.lock\np9\nn/Users/x/.codex/thread-writer-locks/.coordination.lock\n";
        assert_eq!(parse_lsof_locks(raw), vec![(76051, "01a1-b2".to_string())]);
        let parent: HashMap<u32, u32> = [(30, 20), (20, 10), (10, 1)].into_iter().collect();
        let roots: HashSet<u32> = [20].into_iter().collect();
        assert!(descends_from(30, &roots, &parent));
        assert!(!descends_from(10, &roots, &parent));
    }

    #[test]
    fn scan_finds_this_test_runner_free_system_without_panicking() {
        // 실제 시스템을 훑어도 오류 없이 끝난다(결과 내용은 환경마다 다름)
        let _ = scan(&HashSet::new());
    }
}
