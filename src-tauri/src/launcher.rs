use notify::{RecursiveMode, Watcher};
use std::process::Command;
use std::sync::mpsc;
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

    // Start watching for the "menu_load_lock" file deletion *before* activating the
    // game — this is the same signal Flarial Launcher's Minecraft.Bootstrap.cs waits
    // on: the UWP build drops a `*menu_load_lock` file under
    // %APPDATA%\Minecraft Bedrock\Users while the main menu is still loading and
    // deletes it the moment the menu is actually ready. That's a much more precise
    // "safe to inject" signal than "the window class exists", which can fire while
    // the process is still mid-initialization. Set up first so no delete event that
    // happens to land right after activate() gets missed.
    let lock_watch = watch_for_menu_load_ready();

    activate(&info)?;

    let pid = wait_for_game_ready(LAUNCH_TIMEOUT, lock_watch)
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
            fMask: mask,
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

/// Sets up a filesystem watcher on `%APPDATA%\Minecraft Bedrock\Users` (recursive) and
/// returns a receiver that gets a message the moment any `*menu_load_lock` file is
/// deleted anywhere under it — the signal used by `wait_for_game_ready` below. Returns
/// `None` if the watcher can't be set up (folder doesn't exist yet on a fresh install,
/// OS watch limits, etc.) so the caller can fall back to plain window polling instead of
/// failing the whole launch over a missing optimization.
fn watch_for_menu_load_ready() -> Option<mpsc::Receiver<()>> {
    let appdata = std::env::var("APPDATA").ok()?;
    let users_dir = std::path::PathBuf::from(appdata).join("Minecraft Bedrock").join("Users");

    // Nothing to watch yet (e.g. Minecraft has never been launched on this machine) —
    // the caller's polling fallback handles this case instead.
    if !users_dir.exists() {
        return None;
    }

    let (tx, rx) = mpsc::channel();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !matches!(event.kind, notify::EventKind::Remove(_)) {
            return;
        }
        let hit = event
            .paths
            .iter()
            .any(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.ends_with("menu_load_lock")).unwrap_or(false));
        if hit {
            let _ = tx.send(());
        }
    })
    .ok()?;

    watcher.watch(&users_dir, RecursiveMode::Recursive).ok()?;

    // Leak the watcher so it keeps running for the rest of this launch attempt instead
    // of being dropped (and stopping) when this function returns — matches the
    // short-lived, one-shot nature of a single launch() call.
    std::mem::forget(watcher);

    Some(rx)
}

/// Waits for Minecraft to be ready for injection, preferring the precise
/// menu_load_lock-deleted signal from `lock_watch` (see watch_for_menu_load_ready) and
/// falling back to polling for the game window if that signal doesn't arrive — either
/// because the watcher couldn't be set up, or because a sideloaded/non-Store build
/// doesn't use the same lock-file lifecycle (mirrors Flarial Launcher's own
/// IsSideloaded fallback to window-polling for that case). Returns the game's PID.
fn wait_for_game_ready(timeout: Duration, lock_watch: Option<mpsc::Receiver<()>>) -> Option<u32> {
    let deadline = Instant::now() + timeout;

    if let Some(rx) = lock_watch {
        // Race the precise signal against the window appearing anyway, polling
        // lightly in between — covers both "lock file never appears for this
        // install" and "window somehow exists before the lock file is deleted".
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait_slice = remaining.min(POLL_INTERVAL);

            if rx.recv_timeout(wait_slice).is_ok() {
                // Menu finished loading — the window should exist by now or within
                // an instant; a couple of quick retries covers that tiny gap.
                for _ in 0..5 {
                    if let Some(pid) = find_window_pid() {
                        return Some(pid);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            if let Some(pid) = find_window_pid() {
                return Some(pid);
            }
        }
        return None;
    }

    // No watcher available — same polling loop as before.
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
