namespace EnderClient.Core.Models;

public sealed class AppSettings
{
    /// <summary>Root directory Ender Client stores its data in (logs, cached clients, config).</summary>
    public string LauncherDirectory { get; set; } = DefaultLauncherDirectory();

    public List<ClientEntry> Clients { get; set; } = new();

    /// <summary>Name of the ClientEntry currently selected for launch, or null for vanilla.</summary>
    public string? SelectedClientName { get; set; }

    public static string DefaultLauncherDirectory() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EnderClient");
}
