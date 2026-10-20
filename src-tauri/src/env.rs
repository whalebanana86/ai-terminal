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
        // 한글이 깨지지 않도록 UTF-8 로케일을 보장한다.
        if !env.get("LANG").is_some_and(|v| v.to_ascii_lowercase().contains("utf")) {
            env.insert("LANG".into(), "en_US.UTF-8".into());
        }
        env
    })
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
