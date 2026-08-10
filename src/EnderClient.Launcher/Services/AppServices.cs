using EnderClient.Core.Services;

namespace EnderClient.Launcher.Services;

/// <summary>Minimal shared-instance holder — the app is small enough that a full DI container is unnecessary.</summary>
internal static class AppServices
{
    public static SettingsService Settings { get; } = new();
}
