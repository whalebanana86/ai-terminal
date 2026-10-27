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
    let release = match latest_release(&client).await {
        Ok(release) => release,
        // GitHub API 는 로그인 없이 같은 인터넷 주소에서 시간당 60번까지다(같은 와이파이의 다른 기기·프로그램과 나눠 씀).
        // 막히면 API 를 거치지 않는 최신 릴리즈의 업데이트 파일(latest.json)로 확인한다.
        Err(api_error) => {
            return check_from_manifest(&app, &state, current).await.map_err(|e| {
                tr!(
                    "{api_error}\n대신 확인한 업데이트 파일(latest.json)도 읽지 못했습니다: {e}",
                    "{api_error}\nThe fallback update file (latest.json) couldn't be read either: {e}"
                )
            });
        }
    };
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

/// 최신 릴리즈 정보(GitHub API). 요청 한도에 걸리면 알아볼 수 있는 말로 돌려준다.
async fn latest_release(client: &reqwest::Client) -> Result<Release, String> {
    let response = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(tr!(
            "GitHub 요청 한도(로그인 없이 시간당 60번)를 넘었습니다. 잠시 뒤 다시 확인해 주세요.",
            "GitHub's request limit (60 per hour without signing in) was reached. Please check again later."
        ));
    }
    response.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())
}

/// API 없이: 최신 릴리즈의 latest.json 을 업데이트 플러그인으로 바로 확인한다(서명 검증은 설치할 때 그대로).
async fn check_from_manifest(
    app: &tauri::AppHandle,
    state: &State<'_, UpdateState>,
    current: &semver::Version,
) -> Result<UpdateInfo, String> {
    let url = format!("https://github.com/{REPO}/releases/latest/download/latest.json")
        .parse::<reqwest::Url>()
        .map_err(|e| e.to_string())?;
    let update = app
        .updater_builder()
        // API 경로의 newer() 와 같게: 더 높은 정식 버전만(-beta 같은 꼬리표가 붙은 버전은 권하지 않는다)
        .version_comparator(|current, remote| remote.version.pre.is_empty() && remote.version > current)
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(match update {
        Some(mut update) => {
            update.timeout = Some(Duration::from_secs(300));
            let info = UpdateInfo {
                current_version: current.to_string(),
                version: update.version.clone(),
                notes: update.body.clone().unwrap_or_default(),
                available: true,
                automatic: true,
            };
            *state.pending.lock() = Some(update);
            info
        }
        None => UpdateInfo {
            current_version: current.to_string(),
            version: current.to_string(),
            notes: String::new(),
            available: false,
            automatic: false,
        },
    })
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    let _guard = state.begin()?;
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
    update.install(bytes).map_err(|e| e.to_string())?;
    let core = &app.state::<crate::commands::AppState>().core;
    // 터미널에서 실행 중인 에이전트는 끝내지 않고 새 버전 앱으로 넘긴다
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Err(e) = crate::handoff::prepare(core, &data_dir) {
        return Err(tr!(
            "업데이트는 설치했지만 실행 중인 에이전트를 새 버전으로 넘기지 못했습니다({e:#}). 에이전트를 끝낸 뒤 앱을 다시 열면 새 버전이 됩니다.",
            "The update is installed, but running agents couldn't be handed to the new version ({e:#}). Stop the agents and reopen the app to use the new version."
        ));
    }
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
