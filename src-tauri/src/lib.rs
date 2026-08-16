mod discord_auth;
mod injector;
mod launcher;
mod minecraft;
mod modules;
mod settings;
mod updater;

use modules::{list_modules, set_module_enabled};
use settings::{AppSettings, ClientEntry, ClientSourceMode, ModelView};
use updater::{fetch_jod_extension, fetch_latest_latite, get_jod_dll_path};
use std::sync::Mutex;
use tauri::State;

struct AppState {
    settings: Mutex<AppSettings>,
}

/// Entry point for the elevated helper invocation (see main.rs). Expects
/// `args = [pid, dll_path, dll_path, ...]` and performs the injection directly, with no
/// Tauri app / window involved — this process exists only to run briefly under
/// administrator rights and exit. Returns the process exit code: 0 on success, 1 on
/// failure (malformed args or an injection error).
pub fn run_elevated_inject(args: &[String]) -> i32 {
    let Some((pid_arg, dll_paths)) = args.split_first() else {
        return 1;
    };

    let Ok(pid) = pid_arg.parse::<u32>() else {
        return 1;
    };

    if dll_paths.is_empty() {
        return 1;
    }

    for dll in dll_paths {
        if injector::inject(pid, dll).is_err() {
            return 1;
        }
    }

    0
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
    head_bounce_enabled: bool,
    head_bounce_speed: f32,
    head_bounce_amplitude: f32,
    state: State<AppState>,
) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    settings.accent_color = accent_color;
    settings.font_family = font_family;
    settings.model_view = model_view;
    settings.head_bounce_enabled = head_bounce_enabled;
    settings.head_bounce_speed = head_bounce_speed.clamp(
        settings::MIN_HEAD_BOUNCE_SPEED,
        settings::MAX_HEAD_BOUNCE_SPEED,
    );
    settings.head_bounce_amplitude = head_bounce_amplitude.clamp(
        settings::MIN_HEAD_BOUNCE_AMPLITUDE,
        settings::MAX_HEAD_BOUNCE_AMPLITUDE,
    );
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn set_client_source_mode(mode: ClientSourceMode, state: State<AppState>) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    settings.client_source_mode = mode;
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
async fn discord_login(state: State<'_, AppState>) -> Result<AppSettings, String> {
    // The OAuth round-trip (opening the browser, running the local callback
    // server, exchanging the code) doesn't touch AppState — only the final
    // result does — so it runs before we ever take the lock, keeping that
    // lock held for as short as possible.
    let account = discord_auth::login().await?;

    let mut settings = state.settings.lock().unwrap();
    settings.discord_account = Some(account);
    settings::save(&settings).map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn discord_logout(state: State<AppState>) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    settings.discord_account = None;
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
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("Could not open link: {e}"))
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
            set_client_source_mode,
            update_appearance,
            open_directory,
            open_url,
            find_active_skin_path,
            launch_minecraft,
            list_modules,
            set_module_enabled,
            fetch_latest_latite,
            fetch_jod_extension,
            get_jod_dll_path,
            set_jod_enabled,
            discord_login,
            discord_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ender Client");
}
