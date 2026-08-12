use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEntry {
    pub name: String,
    pub dll_path: String,
}

impl ClientEntry {
    pub fn is_valid(&self) -> bool {
        let path = PathBuf::from(&self.dll_path);
        path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("dll")) == Some(true)
            && path.exists()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub launcher_directory: String,
    #[serde(default)]
    pub clients: Vec<ClientEntry>,
    #[serde(default)]
    pub selected_client_name: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            launcher_directory: default_launcher_directory(),
            clients: Vec::new(),
            selected_client_name: None,
        }
    }
}

pub fn default_launcher_directory() -> String {
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    PathBuf::from(local_appdata)
        .join("EnderClient")
        .to_string_lossy()
        .to_string()
}

fn settings_path(launcher_directory: &str) -> PathBuf {
    PathBuf::from(launcher_directory).join("settings.json")
}

/// Loads settings from `<launcher_directory>/settings.json`, falling back to defaults
/// if the file is missing or unreadable (mirrors SettingsService.Load in the old C# code —
/// a corrupt settings file should not crash the app).
pub fn load(launcher_directory: &str) -> AppSettings {
    let path = settings_path(launcher_directory);

    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_else(|_| AppSettings {
            launcher_directory: launcher_directory.to_string(),
            ..Default::default()
        }),
        Err(_) => AppSettings {
            launcher_directory: launcher_directory.to_string(),
            ..Default::default()
        },
    }
}

pub fn save(settings: &AppSettings) -> std::io::Result<()> {
    fs::create_dir_all(&settings.launcher_directory)?;
    let json = serde_json::to_string_pretty(settings)?;
    fs::write(settings_path(&settings.launcher_directory), json)
}
