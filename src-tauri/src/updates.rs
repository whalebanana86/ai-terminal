//! Explicit, signed updates from this project's GitHub Releases only.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const REPO: &str = "whalebanana86/ai-terminal";
const RELEASES: &str = "https://github.com/whalebanana86/ai-terminal/releases/latest";

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
    busy: AtomicBool,
}
struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl UpdateState {
    fn begin(&self) -> Result<BusyGuard<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                tr!(
                    "업데이트 작업이 이미 진행 중입니다.",
                    "An update operation is already in progress."
                )
            })?;
        Ok(BusyGuard(&self.busy))
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    version: String,
    notes: String,
    available: bool,
    automatic: bool,
}

fn newer(tag: &str, current: &semver::Version) -> Result<bool, String> {
    let version =
        semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag)).map_err(|e| e.to_string())?;
    Ok(version.pre.is_empty() && version > *current)
}

fn github_client(current: &semver::Version) -> Result<reqwest::Client, String> {
    // The updater uses ring too. Configure it before the first GitHub API request.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .user_agent(format!("Code-Whereabouts/{current}"))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    let _guard = state.begin()?;
    *state.pending.lock() = None;
    let current = &app.package_info().version;
    let client = github_client(current)?;
    let release: Release = client
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases/latest"
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let available = !release.draft && !release.prerelease && newer(&release.tag_name, current)?;
    let mut info = UpdateInfo {
        current_version: current.to_string(),
        version: release.tag_name.trim_start_matches('v').to_string(),
        notes: release.body.unwrap_or_default(),
        available,
        automatic: false,
    };
    if available && release.assets.iter().any(|a| a.name == "latest.json") {
        // Bind this check to the release we just displayed, even if latest changes meanwhile.
        let url = format!(
            "https://github.com/{REPO}/releases/download/{}/latest.json",
            release.tag_name
        )
        .parse::<reqwest::Url>()
        .map_err(|e| e.to_string())?;
        let mut update = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                tr!(
                    "업데이트 정보를 확인하지 못했습니다. 다시 확인해 주세요.",
                    "Could not confirm the update. Please check again."
                )
            })?;
        if update.version != info.version {
            return Err(tr!(
                "릴리즈와 업데이트 버전이 다릅니다.",
                "Release and update versions do not match."
            ));
        }
        update.timeout = Some(Duration::from_secs(300));
        info.automatic = true;
        *state.pending.lock() = Some(update);
    }
    Ok(info)
}

fn ensure_idle(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<crate::commands::AppState>();
    if state.core.pty.list().iter().any(|e| !e.exited)
        || state.core.chats.list().iter().any(|c| c.busy)
    {
        return Err(tr!(
            "실행 중인 에이전트를 종료한 뒤 업데이트해 주세요.",
            "Stop running agents before updating."
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    let _guard = state.begin()?;
    ensure_idle(&app)?;
    let update = state
        .pending
        .lock()
        .clone()
        .ok_or_else(|| tr!("먼저 업데이트를 확인해 주세요.", "Check for updates first."))?;
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(
                    "update-progress",
                    serde_json::json!({"downloaded": downloaded, "total": total}),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // Agents may have started during the download. Do not interrupt their work.
    ensure_idle(&app)?;
    update.install(bytes).map_err(|e| e.to_string())?;
    let core = &app.state::<crate::commands::AppState>().core;
    core.chats.close_all();
    app.restart();
}

#[tauri::command]
pub fn open_update_download() -> Result<(), String> {
    // Fixed destination; no renderer-provided URL or shell interpolation.
    std::process::Command::new("/usr/bin/open")
        .arg(RELEASES)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err(tr!(
                    "다운로드 페이지를 열지 못했습니다.",
                    "Could not open the download page."
                ))
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn https_client_has_a_crypto_provider() {
        assert!(github_client(&semver::Version::new(0, 2, 1)).is_ok());
    }
    #[test]
    fn stable_upgrade_only() {
        let current = semver::Version::parse("0.2.9").unwrap();
        assert!(newer("v0.2.10", &current).unwrap());
        assert!(!newer("v0.2.9", &current).unwrap());
        assert!(!newer("v0.2.8", &current).unwrap());
        assert!(!newer("v1.0.0-beta.1", &current).unwrap());
        assert!(newer("bad-tag", &current).is_err());
    }
    #[test]
    fn single_operation_and_release_after_failure() {
        let state = UpdateState::default();
        let guard = state.begin().unwrap();
        assert!(state.begin().is_err());
        drop(guard);
        assert!(state.begin().is_ok());
    }
}
