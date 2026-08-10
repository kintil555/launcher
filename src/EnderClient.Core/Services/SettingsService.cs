using System.Text.Json;
using EnderClient.Core.Models;

namespace EnderClient.Core.Services;

/// <summary>
/// Loads and persists <see cref="AppSettings"/> as JSON under the launcher directory.
/// </summary>
public sealed class SettingsService
{
    static readonly JsonSerializerOptions s_jsonOptions = new() { WriteIndented = true };

    string _settingsFilePath;

    public AppSettings Settings { get; private set; }

    public SettingsService()
    {
        Settings = Load(AppSettings.DefaultLauncherDirectory());
        _settingsFilePath = GetSettingsPath(Settings.LauncherDirectory);
    }

    static string GetSettingsPath(string launcherDirectory) =>
        Path.Combine(launcherDirectory, "settings.json");

    static AppSettings Load(string launcherDirectory)
    {
        var path = GetSettingsPath(launcherDirectory);

        if (!File.Exists(path))
            return new AppSettings { LauncherDirectory = launcherDirectory };

        try
        {
            var json = File.ReadAllText(path);
            var settings = JsonSerializer.Deserialize<AppSettings>(json);
            return settings ?? new AppSettings { LauncherDirectory = launcherDirectory };
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            // Corrupt or unreadable settings file — fall back to defaults rather than crash.
            return new AppSettings { LauncherDirectory = launcherDirectory };
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(Settings.LauncherDirectory);
        var json = JsonSerializer.Serialize(Settings, s_jsonOptions);
        File.WriteAllText(_settingsFilePath, json);
    }

    /// <summary>Changes the launcher directory, moving future saves there.</summary>
    public void SetLauncherDirectory(string newDirectory)
    {
        Settings.LauncherDirectory = newDirectory;
        _settingsFilePath = GetSettingsPath(newDirectory);
        Save();
    }
}
