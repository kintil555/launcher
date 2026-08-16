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

## Releasing an update

The app auto-updates itself (via `tauri-plugin-updater`, checked at startup) against
GitHub Releases. To publish a new version:

1. **One-time setup only** — run the "Generate Updater Signing Key" workflow
   (Actions tab → run manually), copy the printed public key into
   `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, download the
   `updater-private-key-DELETE-AFTER-SAVING` artifact, and save its contents as two
   repo secrets: `TAURI_SIGNING_PRIVATE_KEY` (the file's contents) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the password used when generating it — see
   the workflow file). Then delete that artifact and the workflow run. **This private
   key can't be regenerated** — if it's lost, existing installs can no longer receive
   automatic updates signed by it.
2. Bump the version number in **both** `src-tauri/tauri.conf.json` (`"version"`) and
   `src-tauri/Cargo.toml` (`[package] version`) — they must match.
3. Commit, then push a tag matching the version, e.g.:
   ```
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. The `Release` workflow builds, signs, and publishes a GitHub Release with the
   installer and `latest.json`. Launchers already installed will offer the update
   automatically the next time they start.

## Notes
- Launches Minecraft via `Invoke-CommandInDesktopPackage` (the same mechanism Flarial Launcher
  uses) rather than `shell:AppsFolder`, which does not resolve reliably from a plain process spawn.
- Injection waits for the game's actual window (class `Bedrock`) rather than a fixed delay, since
  the UWP app container's startup time varies.
- Targets the Microsoft Store (UWP/GDK) build of Minecraft Bedrock.
- Requires Administrator (embedded in the Windows manifest via `build.rs`) so
  `OpenProcess(PROCESS_ALL_ACCESS)` can get a handle on the Minecraft process for injection.
