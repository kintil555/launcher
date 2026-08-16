use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::minecraft::custom_skins_dir;

#[derive(Serialize)]
pub struct SkinEntry {
    pub filename: String,
    pub path: String,
}

/// Lists every PNG in the game's custom_skins folder (top-level only --
/// this mirrors what SkinLocator/find_active_skin_path already treat as
/// the pool of "known" skins, so behavior stays consistent between the
/// active-skin picker and this list). Newest-modified first.
#[tauri::command]
pub fn list_custom_skins() -> Result<Vec<SkinEntry>, String> {
    let dir = custom_skins_dir()
        .ok_or_else(|| "Minecraft's custom_skins folder was not found yet. Launch the game at least once first.".to_string())?;

    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("png")) == Some(true))
        .filter_map(|p| std::fs::metadata(&p).ok().and_then(|m| m.modified().ok()).map(|t| (t, p)))
        .collect();

    entries.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(entries
        .into_iter()
        .map(|(_, path)| SkinEntry {
            filename: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
        })
        .collect())
}

/// "Activates" a skin already sitting in custom_skins. find_active_skin_path()
/// returns whichever PNG in the folder has the newest mtime, so activating
/// means bumping this file's modified time to now (past whatever skin was
/// previously newest) without touching its bytes.
#[tauri::command]
pub fn set_active_skin(path: String) -> Result<(), String> {
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    file.set_modified(std::time::SystemTime::now()).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Deserialize)]
struct MojangProfileLookup {
    id: String,
}

#[derive(Deserialize)]
struct MojangProfile {
    properties: Vec<MojangProfileProperty>,
}

#[derive(Deserialize)]
struct MojangProfileProperty {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct TexturesPayload {
    textures: TexturesInner,
}

#[derive(Deserialize)]
struct TexturesInner {
    #[serde(rename = "SKIN")]
    skin: Option<TextureUrl>,
}

#[derive(Deserialize)]
struct TextureUrl {
    url: String,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("EnderClient-Launcher")
        .build()
        .map_err(|e| e.to_string())
}

/// Looks up a Java Edition username via Mojang's official (free, no-key)
/// APIs and downloads their current skin PNG into custom_skins, so it
/// shows up in the picker like any other local skin.
///
/// NameMC has no public API and scraping its HTML is fragile/against its
/// terms, so this only supports Java accounts that exist in Mojang's own
/// profile system -- NOT arbitrary NameMC-only "capes"/skin-history entries.
#[tauri::command]
pub async fn fetch_skin_by_username(username: String) -> Result<SkinEntry, String> {
    let username = username.trim();
    if username.is_empty() {
        return Err("Enter a username first.".to_string());
    }

    let client = http_client()?;

    let lookup: MojangProfileLookup = client
        .get(format!("https://api.mojang.com/users/profiles/minecraft/{username}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|_| format!("No Java Edition account found for '{username}'."))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let profile: MojangProfile = client
        .get(format!("https://sessionserver.mojang.com/session/minecraft/profile/{}", lookup.id))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let textures_prop = profile
        .properties
        .iter()
        .find(|p| p.name == "textures")
        .ok_or_else(|| "This account has no skin data.".to_string())?;

    let decoded = STANDARD
        .decode(&textures_prop.value)
        .map_err(|e| e.to_string())?;
    let payload: TexturesPayload = serde_json::from_slice(&decoded).map_err(|e| e.to_string())?;

    let skin_url = payload
        .textures
        .skin
        .ok_or_else(|| format!("'{username}' doesn't have a skin set."))?
        .url;

    let skin_bytes = client
        .get(&skin_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    let dir = custom_skins_dir()
        .ok_or_else(|| "Minecraft's custom_skins folder was not found yet. Launch the game at least once first.".to_string())?;

    // Sanitize: username is validated by Mojang's own lookup succeeding,
    // but strip anything path-unsafe out of an abundance of caution before
    // it becomes part of a filename.
    let safe_name: String = username.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
    let out_path = dir.join(format!("{safe_name}.png"));
    std::fs::write(&out_path, &skin_bytes).map_err(|e| e.to_string())?;

    Ok(SkinEntry {
        filename: out_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
        path: out_path.to_string_lossy().to_string(),
    })
}
