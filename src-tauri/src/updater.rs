use serde::Deserialize;
use std::path::PathBuf;

const RELEASE_API_URL: &str = "https://api.github.com/repos/kintil555/Latite/releases/tags/nightly";
const DLL_ASSET_NAME: &str = "LatiteNightly.dll";

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GhRelease {
    // GitHub bumps this every time the release (and its assets) are
    // recreated — nightly-build.yml deletes + recreates the "nightly"
    // release on every push, so a changed published_at means a new build.
    published_at: String,
    assets: Vec<GhAsset>,
}

fn version_marker_path(launcher_directory: &str) -> PathBuf {
    PathBuf::from(launcher_directory).join("latite_nightly_version.txt")
}

fn dll_path(launcher_directory: &str) -> PathBuf {
    PathBuf::from(launcher_directory).join(DLL_ASSET_NAME)
}

/// Checks the GitHub Release, downloads the DLL only if it's newer than the
/// last one we fetched (or if we've never fetched one), and does nothing
/// otherwise. Returns the local DLL path either way once it's confirmed to
/// exist, so the caller can add/select it as a client.
#[tauri::command]
pub async fn fetch_latest_latite(launcher_directory: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("EnderClient-Launcher")
        .build()
        .map_err(|e| e.to_string())?;

    let release: GhRelease = client
        .get(RELEASE_API_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let asset = release
        .assets
        .iter()
        .find(|a| a.name == DLL_ASSET_NAME)
        .ok_or_else(|| format!("Release has no asset named {DLL_ASSET_NAME}"))?;

    let marker_path = version_marker_path(&launcher_directory);
    let dll_out_path = dll_path(&launcher_directory);

    let last_fetched = std::fs::read_to_string(&marker_path).unwrap_or_default();
    let up_to_date = last_fetched.trim() == release.published_at && dll_out_path.exists();

    if up_to_date {
        return Ok(dll_out_path.to_string_lossy().to_string());
    }

    let bytes = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    std::fs::create_dir_all(&launcher_directory).map_err(|e| e.to_string())?;
    std::fs::write(&dll_out_path, &bytes).map_err(|e| e.to_string())?;
    std::fs::write(&marker_path, &release.published_at).map_err(|e| e.to_string())?;

    Ok(dll_out_path.to_string_lossy().to_string())
}
