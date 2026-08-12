mod injector;
mod launcher;
mod minecraft;
mod settings;

use settings::{AppSettings, ClientEntry};
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
    if settings.selected_client_name.as_deref() == Some(name.as_str()) {
        settings.selected_client_name = None;
    }
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn set_selected_client(name: Option<String>, state: State<AppState>) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    settings.selected_client_name = name;
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
fn launch_minecraft(client_dll_path: Option<String>) -> Result<(), String> {
    launcher::launch(client_dll_path.as_deref())
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
            set_selected_client,
            open_directory,
            find_active_skin_path,
            launch_minecraft,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ender Client");
}
