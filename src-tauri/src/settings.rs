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

/// Which part of the player model the home screen renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelView {
    Head,
    Body,
}

/// Where the launched client DLL comes from. "Release" downloads (or reuses
/// the already-downloaded) official Latite build on demand at launch time;
/// "Custom" uses the user's own client list/selection, same as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientSourceMode {
    Release,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub launcher_directory: String,
    #[serde(default)]
    pub clients: Vec<ClientEntry>,
    /// Up to two client names, injected together in this order.
    #[serde(default)]
    pub selected_client_names: Vec<String>,
    /// Whether the JoD (Jump on Damage) extension DLL should be injected
    /// alongside the selected client(s) at launch.
    #[serde(default)]
    pub jod_extension_enabled: bool,
    /// "Release" (default) downloads/reuses the official Latite build
    /// on-demand at launch; "Custom" uses `clients`/`selected_client_names`.
    #[serde(default = "default_client_source_mode")]
    pub client_source_mode: ClientSourceMode,
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_model_view")]
    pub model_view: ModelView,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            launcher_directory: default_launcher_directory(),
            clients: Vec::new(),
            selected_client_names: Vec::new(),
            jod_extension_enabled: false,
            client_source_mode: default_client_source_mode(),
            accent_color: default_accent_color(),
            font_family: default_font_family(),
            model_view: default_model_view(),
        }
    }
}

fn default_client_source_mode() -> ClientSourceMode {
    ClientSourceMode::Release
}

fn default_accent_color() -> String {
    "#8B5CF6".to_string()
}

fn default_font_family() -> String {
    "Mojangles".to_string()
}

fn default_model_view() -> ModelView {
    ModelView::Head
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
