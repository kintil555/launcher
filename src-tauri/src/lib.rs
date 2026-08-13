mod injector;
mod launcher;
mod minecraft;
mod modules;
mod settings;
mod updater;

use modules::{list_modules, set_module_enabled};
use settings::{AppSettings, ClientEntry, ModelView};
use updater::{fetch_jod_extension, fetch_latest_latite, get_jod_dll_path};
use std::sync::Mutex;
use tauri::State;

struct AppState {
    settings: Mutex<AppSettings>,
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_launcher_directory(directory: String, state: State<AppState>) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    settings.launcher_directory = directory;
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn add_client(name: String, dll_path: String, state: State<AppState>) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();

    // Avoid duplicate names by suffixing, same behavior as the original C# ClientsView.
    let mut final_name = name.clone();
    let mut suffix = 2;
    while settings.clients.iter().any(|c| c.name == final_name) {
        final_name = format!("{name} ({suffix})");
        suffix += 1;
    }

    settings.clients.push(ClientEntry { name: final_name, dll_path });
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn remove_client(name: String, state: State<AppState>) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    settings.clients.retain(|c| c.name != name);
    settings.selected_client_names.retain(|n| n != &name);
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

/// Sets the active client selection. At most two clients can be stacked together;
/// anything beyond that is rejected rather than silently truncated.
#[tauri::command]
fn set_selected_clients(names: Vec<String>, state: State<AppState>) -> Result<AppSettings, String> {
    if names.len() > 2 {
        return Err("At most two clients can be selected at once.".to_string());
    }

    let mut settings = state.settings.lock().unwrap();
    settings.selected_client_names = names;
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn update_appearance(
    accent_color: String,
    font_family: String,
    model_view: ModelView,
    state: State<AppState>,
) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    settings.accent_color = accent_color;
    settings.font_family = font_family;
    settings.model_view = model_view;
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn set_jod_enabled(enabled: bool, state: State<AppState>) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    settings.jod_extension_enabled = enabled;
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn open_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer.exe")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn find_active_skin_path() -> Option<String> {
    minecraft::find_active_skin_path()
}

#[tauri::command]
fn launch_minecraft(client_dll_paths: Vec<String>) -> Result<(), String> {
    launcher::launch(&client_dll_paths)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_settings = settings::load(&settings::default_launcher_directory());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            settings: Mutex::new(initial_settings),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_launcher_directory,
            add_client,
            remove_client,
            set_selected_clients,
            update_appearance,
            open_directory,
            find_active_skin_path,
            launch_minecraft,
            list_modules,
            set_module_enabled,
            fetch_latest_latite,
            fetch_jod_extension,
            get_jod_dll_path,
            set_jod_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ender Client");
}
