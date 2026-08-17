use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::minecraft::custom_skins_dirs;

#[derive(Serialize)]
pub struct SkinEntry {
    pub filename: String,
    pub path: String,
    /// True when the filename is a bare UUID (Minecraft's own naming for a
    /// skin actually imported through the Dressing Room). Only these are
    /// valid overwrite targets -- overwriting one changes what an
    /// already-equipped skin looks like on next game launch. Skins the
    /// launcher itself wrote (fetched by username, uploaded from disk) use
    /// human-readable names and were never registered with Minecraft, so
    /// overwriting them would do nothing.
    pub is_imported: bool,
}

fn is_uuid_filename(filename: &str) -> bool {
    let stem = filename.strip_suffix(".png").or_else(|| filename.strip_suffix(".PNG")).unwrap_or(filename);
    let parts: Vec<&str> = stem.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12] == parts.iter().map(|p| p.len()).collect::<Vec<_>>()[..]
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Lists every PNG across all custom_skins folder candidates (per-account
/// and Shared, top-level only -- this mirrors what SkinLocator/
/// find_active_skin_path already treat as the pool of "known" skins, so
/// behavior stays consistent between the active-skin picker and this list).
/// Newest-modified first.
#[tauri::command]
pub fn list_custom_skins() -> Result<Vec<SkinEntry>, String> {
    let dirs = custom_skins_dirs();
    if dirs.is_empty() {
        return Err("Minecraft's custom_skins folder was not found yet. Launch the game at least once first.".to_string());
    }

    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for dir in &dirs {
        let Ok(read) = std::fs::read_dir(dir) else { continue; };
        entries.extend(
            read.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("png")) == Some(true))
                .filter_map(|p| std::fs::metadata(&p).ok().and_then(|m| m.modified().ok()).map(|t| (t, p))),
        );
    }

    entries.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(entries
        .into_iter()
        .map(|(_, path)| {
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let is_imported = is_uuid_filename(&filename);
            SkinEntry {
                filename,
                path: path.to_string_lossy().to_string(),
                is_imported,
            }
        })
        .collect())
}

/// Overwrites the bytes of an already-imported skin file (one Minecraft's
/// Dressing Room already knows about, hence its UUID filename) with a
/// different skin's bytes, keeping the original filename/UUID untouched.
///
/// This is the only way to change what a Bedrock player looks like without
/// re-opening the Dressing Room: Bedrock keeps a persona/skin database
/// keyed by the skin's UUID (assigned at import time), not by file content
/// or mtime, so a brand-new file just sits unrecognized until imported by
/// hand. Reusing an existing UUID's file — with its texture swapped out —
/// picks up on next launch because the *file* Minecraft already tracks
/// changed, even though the UUID itself didn't.
#[tauri::command]
pub fn overwrite_skin(target_path: String, source_path: String) -> Result<(), String> {
    let target = PathBuf::from(&target_path);
    let source = PathBuf::from(&source_path);

    let dirs = custom_skins_dirs();
    let in_known_dir = dirs.iter().any(|dir| target.parent() == Some(dir.as_path()));
    if !in_known_dir {
        return Err("That file is not in a recognized custom_skins folder.".to_string());
    }
    if !source.is_file() {
        return Err("Source skin file does not exist.".to_string());
    }

    let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes a single skin PNG from wherever it lives in custom_skins. Only
/// deletes paths that actually resolve inside one of the known
/// custom_skins candidate dirs, so this can't be used to delete arbitrary
/// files even if a bogus path were ever passed in.
#[tauri::command]
pub fn delete_skin(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);

    let dirs = custom_skins_dirs();
    let in_known_dir = dirs.iter().any(|dir| target.parent() == Some(dir.as_path()));
    if !in_known_dir {
        return Err("That file is not in a recognized custom_skins folder.".to_string());
    }

    std::fs::remove_file(&target).map_err(|e| e.to_string())
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

    let dirs = custom_skins_dirs();
    let dir = dirs
        .first()
        .ok_or_else(|| "Minecraft's custom_skins folder was not found yet. Launch the game at least once first.".to_string())?;

    // Minecraft's own Dressing Room writes custom_skins entries as bare
    // UUID filenames, and — per testing — deletes any file in that folder
    // that ISN'T named that way the next time the game launches. A
    // human-readable name like "Notch.png" gets wiped before the user ever
    // gets a chance to import it, so the file has to be UUID-named from
    // the moment it's written, not just cosmetically later.
    let out_path = dir.join(format!("{}.png", new_uuid_v4()));
    std::fs::write(&out_path, &skin_bytes).map_err(|e| e.to_string())?;

    let filename = out_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let is_imported = is_uuid_filename(&filename);
    Ok(SkinEntry {
        filename,
        path: out_path.to_string_lossy().to_string(),
        is_imported,
    })
}

/// Copies an arbitrary PNG (chosen via OS file dialog) into the custom_skins
/// folder so it shows up in the picker like any other local skin.
#[tauri::command]
pub fn import_skin_file(source_path: String) -> Result<SkinEntry, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("Selected file does not exist.".to_string());
    }

    let dirs = custom_skins_dirs();
    let dir = dirs
        .first()
        .ok_or_else(|| "Minecraft's custom_skins folder was not found yet. Launch the game at least once first.".to_string())?;

    // Same reasoning as fetch_skin_by_username: Minecraft deletes any
    // custom_skins entry that isn't named as a bare UUID the next time it
    // launches, so the copy has to land under a UUID name, not the
    // original filename (which is also how "Add as new skin" duplicates
    // an already-imported skin under a fresh identity Minecraft hasn't
    // seen yet, rather than colliding with it).
    let out_path = dir.join(format!("{}.png", new_uuid_v4()));

    std::fs::copy(&source, &out_path).map_err(|e| e.to_string())?;

    let filename = out_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let is_imported = is_uuid_filename(&filename);
    Ok(SkinEntry {
        filename,
        path: out_path.to_string_lossy().to_string(),
        is_imported,
    })
}

/// Generates a real random UUIDv4 (lowercase, hyphenated) using the `rand`
/// crate already in use elsewhere in this file — avoids pulling in a whole
/// separate `uuid` dependency for one call site.
fn new_uuid_v4() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);

    // Version 4, variant 1 per RFC 4122.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}{}{}{}-{}{}-{}{}-{}{}-{}{}{}{}{}{}",
        hex[0], hex[1], hex[2], hex[3],
        hex[4], hex[5],
        hex[6], hex[7],
        hex[8], hex[9],
        hex[10], hex[11], hex[12], hex[13], hex[14], hex[15]
    )
}
