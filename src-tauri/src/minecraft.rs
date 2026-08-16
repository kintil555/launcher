use std::path::PathBuf;
use std::process::Command;

const PACKAGE_FAMILY: &str = "Microsoft.MinecraftUWP";

pub struct MinecraftPackageInfo {
    pub package_family_name: String,
    pub installed_path: String,
    pub process_name: String,
}

/// Finds the installed Minecraft Bedrock (UWP) package via PowerShell's Get-AppxPackage,
/// the same approach as the original C# MinecraftLocator — it avoids depending on the
/// Windows App Model COM APIs directly.
pub fn locate() -> Result<MinecraftPackageInfo, String> {
    let script = format!(
        "$p = Get-AppxPackage -Name '{}' | Select-Object -First 1; \
         if ($p) {{ Write-Output \"$($p.PackageFamilyName)|$($p.InstallLocation)\" }}",
        PACKAGE_FAMILY
    );

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();

    let (package_family_name, install_location) = line
        .split_once('|')
        .ok_or_else(|| "Minecraft Bedrock (UWP) was not found on this system.".to_string())?;

    let exe_path = std::fs::read_dir(install_location)
        .map_err(|_| "Minecraft Bedrock (UWP) was not found on this system.".to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name().and_then(|n| n.to_str()) == Some("Minecraft.Windows.exe")
        })
        .ok_or_else(|| "Minecraft Bedrock (UWP) was not found on this system.".to_string())?;

    let process_name = exe_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Minecraft.Windows.exe")
        .to_string();

    Ok(MinecraftPackageInfo {
        package_family_name: package_family_name.to_string(),
        installed_path: install_location.to_string(),
        process_name,
    })
}

/// Returns every existing custom_skins folder candidate. Bedrock stores skins
/// per-account under Users\<xuid>\games\com.mojang\custom_skins, and/or under
/// the shared Users\Shared\games\com.mojang\custom_skins — which one is
/// populated varies by install/login history, so both must be checked.
/// Non-Shared (per-account) folders are ordered first since they're the
/// active player's folder when both exist.
pub fn custom_skins_dirs() -> Vec<PathBuf> {
    let Ok(appdata) = std::env::var("APPDATA") else { return Vec::new(); };
    let users_dir = PathBuf::from(appdata).join("Minecraft Bedrock").join("Users");

    let mut per_account = Vec::new();
    let mut shared = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&users_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let candidate = path.join("games").join("com.mojang").join("custom_skins");
            if !candidate.exists() {
                continue;
            }
            let is_shared = path.file_name().and_then(|n| n.to_str()) == Some("Shared");
            if is_shared {
                shared.push(candidate);
            } else {
                per_account.push(candidate);
            }
        }
    }

    per_account.extend(shared);
    per_account
}

/// Deprecated: use `custom_skins_dirs()`, which checks both the per-account
/// and Shared folders. Kept only for any lingering internal callers.
#[allow(dead_code)]
pub fn custom_skins_dir() -> Option<PathBuf> {
    custom_skins_dirs().into_iter().next()
}

/// Returns the most recently modified skin PNG across all custom_skins
/// candidate folders, if any — ported from EnderClient.Core.Game.SkinLocator.
pub fn find_active_skin_path() -> Option<String> {
    let dirs = custom_skins_dirs();

    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;

    for dir in &dirs {
        for entry in walk_png_files(dir) {
            if let Ok(metadata) = std::fs::metadata(&entry) {
                if let Ok(modified) = metadata.modified() {
                    if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                        newest = Some((modified, entry));
                    }
                }
            }
        }
    }

    newest.map(|(_, path)| path.to_string_lossy().to_string())
}

fn walk_png_files(dir: &PathBuf) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return result };

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            result.extend(walk_png_files(&path));
        } else if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("png")) == Some(true) {
            result.push(path);
        }
    }

    result
}
