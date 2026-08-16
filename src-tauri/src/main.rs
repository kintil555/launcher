// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Elevated helper mode: when the non-admin instance hits an access-denied error while
    // injecting, it relaunches this same exe with "runas" and this hidden flag so the
    // elevated copy performs just the injection and exits — the UI is never opened a
    // second time, and the original (non-admin) window stays the one the user sees.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && args[1] == "--elevated-inject" {
        std::process::exit(ender_client_lib::run_elevated_inject(&args[2..]));
    }

    ender_client_lib::run();
}
