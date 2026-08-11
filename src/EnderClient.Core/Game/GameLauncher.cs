using System.Diagnostics;
using EnderClient.Core.Exceptions;
using EnderClient.Core.Native;

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

        // Activate the UWP app via the Appx module's Invoke-CommandInDesktopPackage
        // cmdlet — the same mechanism Flarial Launcher uses. Unlike "shell:AppsFolder"
        // (a virtual shell path Process.Start cannot resolve on its own), this runs the
        // app's own exe inside its app-container correctly and synchronously.
        var exePath = Path.Combine(info.InstalledPath, info.ProcessName);
        var command =
            $"Invoke-CommandInDesktopPackage -PackageFamilyName '{info.PackageFamilyName}' " +
            $"-AppId 'Game' -PreventBreakaway -Command '{exePath}'";

        using (var activate = Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            ArgumentList = { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command },
            UseShellExecute = false,
            CreateNoWindow = true
        }))
        {
            activate?.WaitForExit();
        }

        var process = await WaitForGameWindowAsync(processName, LaunchTimeout);

        if (clientDllPath is not null)
            Injector.Inject(process.Id, clientDllPath);
    }

    /// <summary>
    /// Waits until the game process exists AND its main window (class "Bedrock", same as
    /// Minecraft's own window class) is up. A fixed delay after "process exists" is not
    /// enough — the UWP app container can take a variable amount of time to finish
    /// initializing, and injecting too early can silently fail. Polling for the actual
    /// window is what Flarial Launcher does, and it's the reliable signal.
    /// </summary>
    static async Task<Process> WaitForGameWindowAsync(string processName, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline)
        {
            var hwnd = NativeMethods.FindWindow("Bedrock", null);
            if (hwnd != IntPtr.Zero)
            {
                NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
                var process = Process.GetProcessesByName(processName).FirstOrDefault(p => p.Id == (int)pid);
                if (process is not null)
                    return process;
            }

            await Task.Delay(200);
        }

        throw new MinecraftLaunchTimeoutException();
    }
}
