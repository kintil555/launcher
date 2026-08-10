namespace EnderClient.Core.Models;

/// <summary>
/// A user-added client (DLL) that can be injected into Minecraft on launch.
/// </summary>
public sealed class ClientEntry
{
    public string Name { get; set; } = string.Empty;

    /// <summary>Full path to the client DLL on disk.</summary>
    public string DllPath { get; set; } = string.Empty;

    public bool IsValid => File.Exists(DllPath) && DllPath.EndsWith(".dll", StringComparison.OrdinalIgnoreCase);
}
