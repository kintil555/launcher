using System.Diagnostics;
using EnderClient.Core.Exceptions;

namespace EnderClient.Core.Game;

/// <summary>Info about the installed Minecraft Bedrock UWP package.</summary>
public sealed record MinecraftPackageInfo(string PackageFamilyName, string InstalledPath, string ProcessName);

/// <summary>
/// Finds the installed Minecraft Bedrock (UWP) package via PowerShell's Get-AppxPackage,
/// avoiding a dependency on the Windows SDK COM app-model APIs.
/// </summary>
public static class MinecraftLocator
{
    const string PackageFamily = "Microsoft.MinecraftUWP";

    public static MinecraftPackageInfo Locate()
    {
        // -Command output: "<PackageFamilyName>|<InstallLocation>"
        var script =
            $"$p = Get-AppxPackage -Name '{PackageFamily}' | Select-Object -First 1; " +
            "if ($p) { Write-Output \"$($p.PackageFamilyName)|$($p.InstallLocation)\" }";

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                ArgumentList = { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script },
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        process.Start();
        var output = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();

        if (string.IsNullOrEmpty(output) || !output.Contains('|'))
            throw new MinecraftNotInstalledException();

        var parts = output.Split('|', 2);
        var packageFamilyName = parts[0];
        var installLocation = parts[1];

        var exePath = Directory.EnumerateFiles(installLocation, "Minecraft.Windows.exe", SearchOption.TopDirectoryOnly)
            .FirstOrDefault();

        if (exePath is null)
            throw new MinecraftNotInstalledException();

        return new MinecraftPackageInfo(packageFamilyName, installLocation, Path.GetFileName(exePath));
    }
}
