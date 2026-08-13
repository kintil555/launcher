use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// Mirrors util::GetLatitePath() in Latite (src/util/Util.cpp): the client
/// writes its config to %APPDATA%\EnderClient\Configs\default.json.
fn latite_config_path() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Could not resolve %APPDATA%".to_string())?;
    Ok(PathBuf::from(appdata).join("EnderClient").join("Configs").join("default.json"))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ModuleInfo {
    pub name: String,
    pub enabled: bool,
}

/// Reads every settings group from default.json that has an "enabled"
/// setting inside it — that's how Latite represents a module (see
/// Module.h: every module always registers a hidden "enabled" Bool
/// setting as the first entry in its own SettingGroup). Groups without
/// one (e.g. global client settings) are skipped since they aren't modules.
#[tauri::command]
pub fn list_modules() -> Result<Vec<ModuleInfo>, String> {
    let path = latite_config_path()?;
    if !path.exists() {
        return Err(
            "Latite config not found yet. Run Minecraft with Latite loaded at least once, then reopen this page."
                .to_string(),
        );
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let mut modules = Vec::new();
    if let Some(groups) = json.get("settings").and_then(|s| s.as_array()) {
        for group in groups {
            let Some(name) = group.get("name").and_then(|n| n.as_str()) else { continue };
            let Some(settings) = group.get("settings").and_then(|s| s.as_array()) else { continue };

            let enabled_setting = settings
                .iter()
                .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("enabled"));

            if let Some(setting) = enabled_setting {
                let enabled = setting.get("value").and_then(|v| v.as_bool()).unwrap_or(false);
                modules.push(ModuleInfo { name: name.to_string(), enabled });
            }
        }
    }

    modules.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(modules)
}

/// Flips a single module's "enabled" value in place and writes the file
/// back. Only that one boolean is touched — every other setting/group in
/// the file is preserved exactly as-is (module-specific settings, keybinds,
/// colors, etc. are left completely alone).
#[tauri::command]
pub fn set_module_enabled(module_name: String, enabled: bool) -> Result<(), String> {
    let path = latite_config_path()?;
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut json: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let groups = json
        .get_mut("settings")
        .and_then(|s| s.as_array_mut())
        .ok_or_else(|| "Malformed config: missing settings array".to_string())?;

    let group = groups
        .iter_mut()
        .find(|g| g.get("name").and_then(|n| n.as_str()) == Some(module_name.as_str()))
        .ok_or_else(|| format!("Module '{module_name}' not found in config"))?;

    let settings = group
        .get_mut("settings")
        .and_then(|s| s.as_array_mut())
        .ok_or_else(|| "Malformed config: module has no settings array".to_string())?;

    let enabled_setting = settings
        .iter_mut()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("enabled"))
        .ok_or_else(|| format!("Module '{module_name}' has no 'enabled' setting"))?;

    enabled_setting["value"] = Value::Bool(enabled);

    let out = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(())
}
