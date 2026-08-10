using System.Diagnostics;
using EnderClient.Core.Exceptions;

namespace EnderClient.Core.Game;

public static class GameLauncher
{
    static readonly TimeSpan LaunchTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Launches Minecraft Bedrock and, if <paramref name="clientDllPath"/> is provided,
    /// injects it once the game process is up.
    /// </summary>
    public static async Task LaunchAsync(string? clientDllPath = null)
    {
        var info = MinecraftLocator.Locate();
        var processName = Path.GetFileNameWithoutExtension(info.ProcessName);

        // Already running? Just inject / focus instead of relaunching.
        var existing = Process.GetProcessesByName(processName).FirstOrDefault();
        if (existing is not null)
        {
            if (clientDllPath is not null)
                Injector.Inject(existing.Id, clientDllPath);
            return;
        }

        // Activate the UWP app via its App Execution Alias / AppsFolder shortcut.
        // This is the same mechanism Windows uses for Start Menu tiles and avoids
        // needing the full app-activation COM API surface.
        Process.Start(new ProcessStartInfo
        {
            FileName = $"shell:AppsFolder\\{info.PackageFamilyName}!App",
            UseShellExecute = true
        });

        var process = await WaitForProcessAsync(processName, LaunchTimeout);

        if (clientDllPath is not null)
            Injector.Inject(process.Id, clientDllPath);
    }

    static async Task<Process> WaitForProcessAsync(string processName, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline)
        {
            var process = Process.GetProcessesByName(processName).FirstOrDefault();
            if (process is not null)
            {
                // Give the process a brief moment to finish its own module initialization
                // before we attempt to inject, to avoid racing its own DLL loads.
                await Task.Delay(1500);
                return process;
            }

            await Task.Delay(250);
        }

        throw new MinecraftLaunchTimeoutException();
    }
}
