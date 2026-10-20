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
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // -i 로 .zshrc 까지 읽어야 volta 같은 PATH 설정이 들어온다. rc 출력과 섞이지 않게 표지를 둔다.
    let script = format!("printf '{START}'; /usr/bin/env -0; printf '{END}'");
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // rc 파일이 멈추는 경우를 대비한 제한 시간.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(30))
            }
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let body = text.split(START).nth(1)?.split(END).next()?;
    let mut map = HashMap::new();
    for entry in body.split('\0') {
        if let Some((k, v)) = entry.split_once('=') {
            if !k.is_empty() && !k.contains(char::is_whitespace) {
                map.insert(k.to_string(), v.to_string());
            }
        }
    }
    // 셸 내부 변수는 자식 프로세스에 넘기지 않는다.
    for k in ["PWD", "OLDPWD", "SHLVL", "_"] {
        map.remove(k);
    }
    Some(map)
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
    std::env::var_os("AITERM_HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
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
}
