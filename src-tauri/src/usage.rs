//! Read-only subscription quota metadata. Never launches an inference turn or changes auth.
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    used_percent: f64,
    window_minutes: u64,
    resets_at: Option<i64>,
    reset_text: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    provider: String,
    windows: Vec<Window>,
    checked_at: u64,
    error: Option<String>,
}
fn report(provider: &str, result: Result<Vec<Window>, &'static str>) -> Quota {
    let (windows, error) = match result {
        Ok(w) if !w.is_empty() => (w, None),
        Ok(_) => (vec![], Some("unavailable".into())),
        Err(e) => (vec![], Some(e.into())),
    };
    Quota {
        provider: provider.into(),
        windows,
        error,
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    }
}
fn percentage(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 100.0)
}
fn codex_windows(v: &Value) -> Vec<Window> {
    let bucket = v
        .pointer("/rateLimitsByLimitId/codex")
        .unwrap_or(&v["rateLimits"]);
    ["primary", "secondary"]
        .iter()
        .filter_map(|key| {
            let w = &bucket[key];
            Some(Window {
                used_percent: percentage(&w["usedPercent"])?,
                window_minutes: w["windowDurationMins"].as_u64().filter(|n| *n > 0)?,
                resets_at: w["resetsAt"].as_i64(),
                reset_text: None,
            })
        })
        .collect()
}
fn claude_windows(v: &Value) -> Vec<Window> {
    [("five_hour", 300), ("seven_day", 10080)]
        .iter()
        .filter_map(|(key, minutes)| {
            let w = &v[key];
            Some(Window {
                used_percent: percentage(&w["utilization"])?,
                window_minutes: *minutes,
                resets_at: None,
                reset_text: w["resets_at"].as_str().map(String::from),
            })
        })
        .collect()
}
fn codex() -> Result<Vec<Window>, &'static str> {
    let bin = crate::env::which("codex").ok_or("cli_missing")?;
    let mut child = Command::new(bin)
        .arg("app-server")
        .env_clear()
        .envs(crate::env::shell_env())
        .current_dir(crate::env::home_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "unavailable")?;
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = writeln!(
        input,
        "{}",
        json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"code_whereabouts","version":env!("CARGO_PKG_VERSION")}}})
    );
    let reader = std::thread::spawn(move || {
        // Only inspect responses to our two requests; no account identifiers or credentials leave here.
        for line in BufReader::new(output).lines().take(100) {
            let Ok(line) = line else { break };
            if line.len() > 2_000_000 {
                break;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["id"] == 1 {
                if v.get("error").is_some() {
                    break;
                }
                if writeln!(input, "{}", json!({"method":"initialized"})).is_err() {
                    break;
                }
                if writeln!(
                    input,
                    "{}",
                    json!({"id":2,"method":"account/rateLimits/read"})
                )
                .is_err()
                {
                    break;
                }
            }
            if v["id"] == 2 {
                let result = if v.get("error").is_some() {
                    Err("login_required")
                } else {
                    Ok(codex_windows(&v["result"]))
                };
                let _ = tx.send(result);
                break;
            }
        }
    });
    let result = rx
        .recv_timeout(Duration::from_secs(18))
        .unwrap_or(Err("timeout"));
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    result
}

fn credentials() -> Result<String, &'static str> {
    // Honour Claude's configured directory. Never change the user's statusLine hook or OAuth tokens.
    let path = crate::sessions::claude_dir().join(".credentials.json");
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(t) = v
                .pointer("/claudeAiOauth/accessToken")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            {
                return Ok(t.into());
            }
        }
    }
    if crate::sessions::claude_dir() != crate::env::home_dir().join(".claude") {
        return Err("login_required");
    }
    #[cfg(target_os = "macos")]
    {
        // security is bounded and stdout stays in memory; a denied/missing item is a login-required state.
        let mut child = Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "login_required")?;
        let stdout = child.stdout.take().unwrap();
        let read = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = stdout.take(1_000_000).read_to_end(&mut b);
            b
        });
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                let _ = read.join();
                return Err("login_required");
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        let bytes = read.join().unwrap_or_default();
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(t) = v
                .pointer("/claudeAiOauth/accessToken")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
            {
                return Ok(t.into());
            }
        }
    }
    Err("login_required")
}
async fn claude() -> Result<Vec<Window>, &'static str> {
    let token = tauri::async_runtime::spawn_blocking(credentials)
        .await
        .map_err(|_| "unavailable")??;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "unavailable")?;
    // Claude Code's OAuth usage endpoint; not a messages/inference request. This endpoint may change.
    let response = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|_| "network")?;
    match response.status().as_u16() {
        401 | 403 => return Err("login_required"),
        429 => return Err("rate_limited"),
        _ => {}
    }
    if !response.status().is_success() {
        return Err("unavailable");
    }
    let data: Value = response.json().await.map_err(|_| "unavailable")?;
    Ok(claude_windows(&data))
}
static CACHE: OnceLock<Mutex<Option<(Instant, Vec<Quota>)>>> = OnceLock::new();
#[tauri::command]
pub async fn subscription_usage(app: tauri::AppHandle) -> Vec<Quota> {
    use tauri::Manager;
    // 설정에서 '구독 한도 표시' 를 끄면 로그인 정보를 읽지 않는다
    let on = app.try_state::<crate::commands::AppState>().is_some_and(|s| crate::extensions::enabled(&s.core.db, crate::extensions::USAGE));
    if !on {
        return Vec::new();
    }
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((at, value)) = cache.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(120) {
            return value.clone();
        }
    }
    let codex_task = tauri::async_runtime::spawn_blocking(codex);
    let claude_result = claude().await;
    let codex_result = codex_task.await.unwrap_or(Err("unavailable"));
    let value = vec![
        report("claude", claude_result),
        report("codex", codex_result),
    ];
    *cache.lock().unwrap() = Some((Instant::now(), value.clone()));
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_preserves_real_windows_and_zero() {
        let w = codex_windows(
            &json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":123},"secondary":{"usedPercent":81,"windowDurationMins":10080}}}}),
        );
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].used_percent, 0.);
        assert_eq!(w[1].window_minutes, 10080);
        assert_eq!(w[0].resets_at, Some(123));
    }
    #[test]
    fn missing_is_never_zero() {
        assert!(codex_windows(&json!({})).is_empty());
        assert!(claude_windows(&json!({"five_hour":null})).is_empty());
        assert!(report("claude", Ok(vec![])).error.is_some());
    }
    #[test]
    fn claude_percentages_and_resets() {
        let w = claude_windows(
            &json!({"five_hour":{"utilization":42.5,"resets_at":"2026-10-21T12:00:00Z"},"seven_day":{"utilization":101}}),
        );
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].used_percent, 42.5);
        assert!(w[0].reset_text.is_some());
    }
}
