use std::process::Command;
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
use windows::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowThreadProcessId, SW_SHOWNORMAL};

use crate::injector;
use crate::minecraft::{self, MinecraftPackageInfo};

const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Launches Minecraft Bedrock and injects each of `client_dll_paths` (in order) once the
/// game window is actually up. Multiple entries let two clients be stacked together.
///
/// The app itself always runs as a normal (non-admin) process — see build.rs, which sets
/// asInvoker rather than requireAdministrator. DLL injection can still fail with an
/// access-denied error depending on the target process, in which case we elevate just
/// for that one operation: relaunch our own exe with a hidden "do the injection and
/// exit" flag via ShellExecuteW's "runas" verb, which triggers a single UAC prompt, and
/// let that elevated child process do the actual CreateRemoteThread call.
pub fn launch(client_dll_paths: &[String]) -> Result<(), String> {
    let info = minecraft::locate()?;

    let process_name_no_ext = info
        .process_name
        .strip_suffix(".exe")
        .unwrap_or(&info.process_name);

    // Already running? Just inject / do nothing further instead of relaunching.
    if let Some(pid) = find_window_pid() {
        return inject_all(pid, client_dll_paths);
    }

    activate(&info)?;

    let pid = wait_for_game_window(LAUNCH_TIMEOUT)
        .ok_or_else(|| "Minecraft did not start within the expected time.".to_string())?;

    let _ = process_name_no_ext; // kept for parity with the locator's process_name field

    inject_all(pid, client_dll_paths)
}

/// Injects every DLL into `pid`, transparently retrying via an elevated child process if
/// the very first injection attempt fails specifically because of insufficient privileges.
fn inject_all(pid: u32, client_dll_paths: &[String]) -> Result<(), String> {
    if client_dll_paths.is_empty() {
        return Ok(());
    }

    match injector::inject(pid, &client_dll_paths[0]) {
        Ok(()) => {
            for dll in &client_dll_paths[1..] {
                injector::inject(pid, dll)?;
            }
            Ok(())
        }
        Err(err) if injector::is_access_denied(&err) => elevate_and_inject(pid, client_dll_paths),
        Err(err) => Err(err),
    }
}

/// Relaunches this same executable, elevated, with a hidden flag that makes it perform
/// just the injection and exit immediately rather than opening the UI again. Triggers one
/// UAC prompt, then blocks until that elevated helper process exits so the caller's
/// Result actually reflects whether injection succeeded — a plain ShellExecuteW "runas"
/// call is fire-and-forget and would report success before the elevated process had even
/// finished (or started) injecting.
fn elevate_and_inject(pid: u32, client_dll_paths: &[String]) -> Result<(), String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Could not resolve the launcher's own path: {e}"))?;

    let mut args = format!("--elevated-inject {pid}");
    for dll in client_dll_paths {
        args.push_str(" \"");
        args.push_str(dll);
        args.push('"');
    }

    let exe_wide: Vec<u16> = exe_path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let args_wide: Vec<u16> = args.encode_utf16().chain(std::iter::once(0)).collect();
    let verb_wide: Vec<u16> = "runas\0".encode_utf16().collect();

    unsafe {
        let mask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: mask.0,
            lpVerb: PCWSTR(verb_wide.as_ptr()),
            lpFile: PCWSTR(exe_wide.as_ptr()),
            lpParameters: PCWSTR(args_wide.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };

        ShellExecuteExW(&mut info).map_err(|_| {
            "Injection requires administrator privileges, and the elevation prompt was \
             declined or failed to start."
                .to_string()
        })?;

        if info.hProcess.is_invalid() {
            return Err(
                "Injection requires administrator privileges, and the elevation prompt was \
                 declined or failed to start."
                    .to_string(),
            );
        }

        WaitForSingleObject(info.hProcess, INFINITE);

        let mut exit_code: u32 = 1;
        let _ = windows::Win32::System::Threading::GetExitCodeProcess(info.hProcess, &mut exit_code);
        let _ = CloseHandle(info.hProcess);

        if exit_code != 0 {
            return Err(
                "Elevated injection failed. Make sure the client DLL path is correct and try again."
                    .to_string(),
            );
        }
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
