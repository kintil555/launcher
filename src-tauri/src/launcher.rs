use std::process::Command;
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowThreadProcessId};

use crate::injector;
use crate::minecraft::{self, MinecraftPackageInfo};

const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Launches Minecraft Bedrock and, if `client_dll_path` is provided, injects it once the
/// game window is actually up.
pub fn launch(client_dll_path: Option<&str>) -> Result<(), String> {
    let info = minecraft::locate()?;

    let process_name_no_ext = info
        .process_name
        .strip_suffix(".exe")
        .unwrap_or(&info.process_name);

    // Already running? Just inject / do nothing further instead of relaunching.
    if let Some(pid) = find_window_pid() {
        if let Some(dll) = client_dll_path {
            injector::inject(pid, dll)?;
        }
        return Ok(());
    }

    activate(&info)?;

    let pid = wait_for_game_window(LAUNCH_TIMEOUT)
        .ok_or_else(|| "Minecraft did not start within the expected time.".to_string())?;

    let _ = process_name_no_ext; // kept for parity with the locator's process_name field

    if let Some(dll) = client_dll_path {
        injector::inject(pid, dll)?;
    }

    Ok(())
}

/// Activates the UWP app via the Appx module's Invoke-CommandInDesktopPackage cmdlet —
/// the same mechanism Flarial Launcher uses. Unlike "shell:AppsFolder" (a virtual shell
/// path that a plain process spawn cannot resolve), this runs the app's own exe inside
/// its app-container correctly and synchronously.
fn activate(info: &MinecraftPackageInfo) -> Result<(), String> {
    let exe_path = format!("{}\\{}", info.installed_path, info.process_name);

    let command = format!(
        "Invoke-CommandInDesktopPackage -PackageFamilyName '{}' -AppId 'Game' -PreventBreakaway -Command '{}'",
        info.package_family_name, exe_path
    );

    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &command])
        .status()
        .map_err(|e| format!("Failed to launch Minecraft: {e}"))?;

    Ok(())
}

/// Waits until the game's main window (class "Bedrock") exists, and returns the owning
/// process id. A fixed delay after "process exists" is not enough — the UWP app
/// container can take a variable amount of time to finish initializing, and injecting
/// too early can silently fail. Polling for the actual window is the reliable signal.
fn wait_for_game_window(timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if let Some(pid) = find_window_pid() {
            return Some(pid);
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    None
}

fn find_window_pid() -> Option<u32> {
    unsafe {
        let class_name: Vec<u16> = "Bedrock\0".encode_utf16().collect();
        let hwnd: HWND = FindWindowW(PCWSTR(class_name.as_ptr()), PCWSTR::null()).ok()?;

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        if pid == 0 {
            None
        } else {
            Some(pid)
        }
    }
}
