//! 사용자 로그인 셸의 환경변수를 한 번 읽어 와서 git·claude·codex 실행에 쓴다.
//!
//! Finder/Dock 에서 연 macOS 앱은 PATH 가 `/usr/bin:/bin:/usr/sbin:/sbin` 뿐이라
//! volta·homebrew·~/.local/bin 에 있는 CLI 를 찾지 못한다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

static SHELL_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// 프로세스 환경변수(AITERM_HOME, AITERM_*_BIN)를 바꾸는 테스트끼리 직렬화하는 잠금
#[cfg(test)]
pub static TEST_ENV_LOCK: parking_lot::Mutex<()> = parking_lot::const_mutex(());

const START: &str = "__AITERM_ENV_START__";
const END: &str = "__AITERM_ENV_END__";

/// 로그인 셸 환경. 실패하면 현재 프로세스 환경을 쓴다.
pub fn shell_env() -> &'static HashMap<String, String> {
    SHELL_ENV.get_or_init(|| {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        if let Some(loaded) = load_login_env() {
            env.extend(loaded);
        }
        // 앱을 띄운 에이전트 세션의 변수를 자식에게 물려주면, 재개한 CLI 가 자신을 하위 세션으로 알고
        // 기록 저장을 끄는 등 오동작한다. 세션에 묶인 변수만 지운다(사용자 설정 변수는 유지).
        env.retain(|k, _| !is_inherited_session_var(k));
        let path = with_fallback_path(env.get("PATH").map(String::as_str).unwrap_or(""));
        env.insert("PATH".into(), path);
        // 한글이 깨지지 않도록 UTF-8 로케일을 보장한다.
        if !env.get("LANG").is_some_and(|v| v.to_ascii_lowercase().contains("utf")) {
            env.insert("LANG".into(), "en_US.UTF-8".into());
        }
        env
    })
}

/// 부모 에이전트 세션에서 새어 들어온, 특정 실행에 묶인 환경변수인지
pub fn is_inherited_session_var(k: &str) -> bool {
    const EXACT: &[&str] = &[
        "CLAUDECODE",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
        "AI_AGENT",
        "CODEX_SANDBOX",
        "CODEX_SANDBOX_NETWORK_DISABLED",
        "CODEX_THREAD_ID",
        "CODEX_CI",
    ];
    const PREFIX: &[&str] = &[
        "CLAUDE_CODE_SESSION",
        "CLAUDE_CODE_CHILD",
        "CLAUDE_CODE_MESSAGING",
        "CODEX_THREAD",
        "CODEX_SESSION",
        "ORCA_",
        "AITERM_AUTOMATION",
    ];
    EXACT.contains(&k) || PREFIX.iter().any(|p| k.starts_with(p))
}

fn load_login_env() -> Option<HashMap<String, String>> {
    let mut shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // csh/tcsh 는 `-l` 을 다른 인자와 함께 쓸 수 없다. macOS 기본 셸로 대신 읽는다.
    if shell.ends_with("csh") || !Path::new(&shell).exists() {
        shell = "/bin/zsh".into();
    }
    // 1차: 로그인 + 대화형(-i) 이어야 .zshrc 의 volta/nvm PATH 가 들어온다.
    // 2차: .zshrc 가 `exec tmux`/`exec fish` 로 셸을 바꿔 버리는 사용자를 위해 로그인 셸만.
    capture_env(&shell, &["-l", "-i", "-c"]).or_else(|| capture_env(&shell, &["-l", "-c"]))
}

fn capture_env(shell: &str, flags: &[&str]) -> Option<HashMap<String, String>> {
    // rc 출력과 섞이지 않게 표지를 둔다.
    let script = format!("printf '{START}'; /usr/bin/env -0; printf '{END}'");
    let mut child = Command::new(shell)
        .args(flags)
        .arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // 출력은 따로 읽는다. 기다리기만 하면 rc 출력이 파이프 버퍼(64KB)를 넘을 때 셸이 멈춘다.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut b);
        b
    });
    // rc 파일이 멈추는 경우를 대비한 제한 시간.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = reader.join().ok()?;
    let text = String::from_utf8_lossy(&out);
    let body = text.split(START).nth(1)?.split(END).next()?;
    let mut map = HashMap::new();
    for entry in body.split('\0') {
        if let Some((k, v)) = entry.split_once('=')
            && !k.is_empty()
            && !k.contains(char::is_whitespace)
        {
            map.insert(k.to_string(), v.to_string());
        }
    }
    // 셸 내부 변수는 자식 프로세스에 넘기지 않는다.
    for k in ["PWD", "OLDPWD", "SHLVL", "_"] {
        map.remove(k);
    }
    map.contains_key("PATH").then_some(map)
}

/// 셸 환경을 못 읽었거나 PATH 에 빠졌을 때를 대비해 흔한 설치 위치를 PATH 끝에 덧붙인다.
fn with_fallback_path(path: &str) -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut parts: Vec<String> = std::env::split_paths(path).map(|p| p.to_string_lossy().into_owned()).collect();
    let extra = [
        home.join(".local/bin"),
        home.join(".volta/bin"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
        home.join(".npm-global/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    for e in extra {
        let e = e.to_string_lossy().into_owned();
        if Path::new(&e).is_dir() && !parts.contains(&e) {
            parts.push(e);
        }
    }
    parts.join(":")
}

/// PATH 에서 실행 파일을 찾는다.
pub fn which(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        let p = PathBuf::from(program);
        return is_executable(&p).then_some(p);
    }
    let path = shell_env().get("PATH")?;
    std::env::split_paths(path)
        .map(|dir| dir.join(program))
        .find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

pub fn home_dir() -> PathBuf {
    // 테스트에서 가짜 HOME 을 쓰기 위해 환경변수를 먼저 본다.
    #[cfg(debug_assertions)]
    if let Some(h) = std::env::var_os("AITERM_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_parent_session_vars_but_keeps_user_config() {
        for k in ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "ORCA_AGENT_SESSION_ID", "CODEX_THREAD_ID"] {
            assert!(is_inherited_session_var(k), "{k}");
        }
        for k in ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
            assert!(!is_inherited_session_var(k), "{k}");
        }
        assert!(!shell_env().keys().any(|k| is_inherited_session_var(k)));
    }

    #[test]
    fn huge_rc_output_and_exec_in_rc_still_yield_env() {
        let d = tempfile::tempdir().unwrap();
        // 64KB 를 훨씬 넘는 출력을 내는 셸 흉내
        let noisy = d.path().join("noisy.sh");
        std::fs::write(&noisy, "#!/bin/sh\nhead -c 300000 /dev/zero | tr '\\0' x\nshift $(($#-1))\nexec /bin/sh -c \"$1\"\n").unwrap();
        std::fs::set_permissions(&noisy, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let env = capture_env(noisy.to_str().unwrap(), &["-l", "-c"]).expect("must not deadlock on big output");
        assert!(env.contains_key("PATH"));
        // -i 에서 실패(셸이 다른 걸 exec)하면 None → 호출부가 -l 로 다시 시도한다
        let execs = d.path().join("execs.sh");
        std::fs::write(&execs, "#!/bin/sh\ncase \"$*\" in *-i*) exec /usr/bin/true;; esac\nshift $(($#-1))\nexec /bin/sh -c \"$1\"\n").unwrap();
        std::fs::set_permissions(&execs, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(capture_env(execs.to_str().unwrap(), &["-l", "-i", "-c"]).is_none());
        assert!(capture_env(execs.to_str().unwrap(), &["-l", "-c"]).is_some());
    }

    #[test]
    fn fallback_path_appends_existing_dirs_once() {
        let p = with_fallback_path("/usr/bin:/custom");
        assert!(p.starts_with("/usr/bin:/custom"));
        assert_eq!(p.matches(":/usr/bin").count() + usize::from(p.starts_with("/usr/bin")), 1);
    }
}
