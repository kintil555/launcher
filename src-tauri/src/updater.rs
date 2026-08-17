use serde::Deserialize;
use std::path::PathBuf;

const REPO_RELEASES_URL: &str = "https://api.github.com/repos/kintil555/Latite/releases";
const REPO_LATEST_RELEASE_URL: &str = "https://api.github.com/repos/kintil555/Latite/releases/latest";

// GitHub's "latest" release endpoint always resolves to the newest release
// that is NOT marked pre-release/draft — that's exactly the stable v2.x
// builds (e.g. v2.0.1), which is what the launcher should be fetching.
// ("Latite Debug" builds are marked pre-release on purpose and are
// deliberately skipped by /releases/latest.)
const LATITE_DLL_NAME: &str = "Latite.dll";

// JoD ships as its own always-on, single-module build (JumpOnDamage only,
// no GUI) — a separate DLL the user can add alongside their main client.
// It doesn't have a stable "latest" GitHub endpoint (that slot is taken by
// Latite's own v2.x releases), so we list all releases and take the newest
// one whose tag starts with "jod-v".
const JOD_TAG_PREFIX: &str = "jod-v";
const JOD_DLL_NAME: &str = "LatiteJoD.dll";

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    // GitHub bumps this every time a release's assets are replaced (e.g. a
    // new v2.x build is published under a new tag) — a changed published_at
    // means a new build the launcher hasn't downloaded yet.
    published_at: String,
    assets: Vec<GhAsset>,
}

fn marker_path(launcher_directory: &str, key: &str) -> PathBuf {
    PathBuf::from(launcher_directory).join(format!("{key}_version.txt"))
}

fn dll_out_path(launcher_directory: &str, dll_name: &str) -> PathBuf {
    PathBuf::from(launcher_directory).join(dll_name)
}

async fn fetch_latest_release(client: &reqwest::Client) -> Result<GhRelease, String> {
    client
        .get(REPO_LATEST_RELEASE_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Lists every release and returns the newest (releases come back
/// newest-first) whose tag starts with `prefix`.
async fn fetch_latest_release_by_tag_prefix(
    client: &reqwest::Client,
    prefix: &str,
) -> Result<GhRelease, String> {
    let releases: Vec<GhRelease> = client
        .get(REPO_RELEASES_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    releases
        .into_iter()
        .find(|r| r.tag_name.starts_with(prefix))
        .ok_or_else(|| format!("No release found with tag prefix '{prefix}'"))
}

/// Downloads `dll_name` from `release` into `launcher_directory`, but only
/// if `release.published_at` differs from what we recorded last time (or
/// nothing's been downloaded yet). Returns the local DLL path either way.
async fn download_if_new(
    client: &reqwest::Client,
    launcher_directory: &str,
    marker_key: &str,
    dll_name: &str,
    release: &GhRelease,
) -> Result<String, String> {
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == dll_name)
        .ok_or_else(|| format!("Release '{}' has no asset named {dll_name}", release.tag_name))?;

    let marker = marker_path(launcher_directory, marker_key);
    let out_path = dll_out_path(launcher_directory, dll_name);

    let last_fetched = std::fs::read_to_string(&marker).unwrap_or_default();
    let up_to_date = last_fetched.trim() == release.published_at && out_path.exists();

    if !up_to_date {
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

        std::fs::create_dir_all(launcher_directory).map_err(|e| e.to_string())?;
        std::fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;
        std::fs::write(&marker, &release.published_at).map_err(|e| e.to_string())?;
    }

    Ok(out_path.to_string_lossy().to_string())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("EnderClient-Launcher")
        .build()
        .map_err(|e| e.to_string())
}

/// Fetches the main Latite client build (the newest non-pre-release GitHub
/// Release, e.g. v2.0.1). No-ops if already up to date.
#[tauri::command]
pub async fn fetch_latest_latite(launcher_directory: String) -> Result<String, String> {
    let client = http_client()?;
    let release = fetch_latest_release(&client).await?;
    download_if_new(&client, &launcher_directory, "latite_stable", LATITE_DLL_NAME, &release).await
}

/// Fetches the JoD (Jump on Damage) extension build. No-ops if already up
/// to date. This is a standalone always-on module DLL, meant to be added as
/// a second client alongside the user's main one (the injector already
/// supports up to two DLLs at once).
#[tauri::command]
pub async fn fetch_jod_extension(launcher_directory: String) -> Result<String, String> {
    let client = http_client()?;
    let release = fetch_latest_release_by_tag_prefix(&client, JOD_TAG_PREFIX).await?;
    download_if_new(&client, &launcher_directory, "jod_extension", JOD_DLL_NAME, &release).await
}

/// Returns the local JoD DLL path if it's already been downloaded via
/// fetch_jod_extension, so it can be appended to the injection list at
/// launch time without needing the user to add it as a regular client.
#[tauri::command]
pub fn get_jod_dll_path(launcher_directory: String) -> Option<String> {
    let path = dll_out_path(&launcher_directory, JOD_DLL_NAME);
    if path.exists() {
        Some(path.to_string_lossy().to_string())
    } else {
        None
    }
}
