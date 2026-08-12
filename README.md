# Ender Client Launcher

Minimal launcher for Minecraft Bedrock (UWP) that injects custom clients such as [Latite](https://github.com/kintil555/Latite) on launch.

Built with [Tauri](https://tauri.app) (Rust backend + HTML/CSS/JS frontend) — the same
architecture used by other Minecraft Bedrock launchers (e.g. Blueberry Client), using
[skinview3d](https://github.com/bs-community/skinview3d) for the 3D player head preview.

## Features
- **Home** — pick a client, see a live-rotating preview of your skin, and launch
- **Clients** — add/remove client DLLs
- **Directory** — view/change where launcher data is stored

## Build

Requires the [Rust toolchain](https://rustup.rs) and, on Windows, the
[WebView2 runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed
on Windows 11).

```
cargo install tauri-cli --version "^2"
cargo tauri build
```

Or via GitHub Actions (`.github/workflows/build.yml`) — an installer artifact is produced on
every push.

## Notes
- Launches Minecraft via `Invoke-CommandInDesktopPackage` (the same mechanism Flarial Launcher
  uses) rather than `shell:AppsFolder`, which does not resolve reliably from a plain process spawn.
- Injection waits for the game's actual window (class `Bedrock`) rather than a fixed delay, since
  the UWP app container's startup time varies.
- Targets the Microsoft Store (UWP/GDK) build of Minecraft Bedrock.
- Requires Administrator (embedded in the Windows manifest via `build.rs`) so
  `OpenProcess(PROCESS_ALL_ACCESS)` can get a handle on the Minecraft process for injection.
