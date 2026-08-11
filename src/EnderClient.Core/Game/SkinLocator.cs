namespace EnderClient.Core.Game;

/// <summary>
/// Finds the player's current skin PNG under the Minecraft Bedrock data directory
/// (...\Minecraft Bedrock\Users\Shared\games\com.mojang\custom_skins).
/// </summary>
public static class SkinLocator
{
    /// <summary>
    /// Returns the path to the most recently modified skin PNG in the custom_skins folder,
    /// or null if Minecraft data / no skins can be found.
    /// </summary>
    public static string? FindActiveSkinPath()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var skinsDir = Path.Combine(appData, "Minecraft Bedrock", "Users", "Shared", "games", "com.mojang", "custom_skins");

        if (!Directory.Exists(skinsDir))
            return null;

        return Directory.EnumerateFiles(skinsDir, "*.png", SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
    }
}
