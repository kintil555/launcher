# Ender Client Launcher

Minimal launcher for Minecraft Bedrock (UWP) that injects custom clients such as [Latite](https://github.com/kintil555/Latite) on launch.

## Features
- Home: pick a client and launch
- Clients: add/remove client DLLs
- Directory: view/change where launcher data is stored

## Build
Requires .NET 8 SDK + Windows (Avalonia desktop, win-x64 target).

```
dotnet build EnderClient.sln -c Release
```

Or via GitHub Actions (`.github/workflows/build.yml`) — artifact `EnderClient-win-x64` is produced on every push.

## Notes
- Requires Administrator (see `app.manifest`) to open the Minecraft process handle for DLL injection.
- Targets the Microsoft Store (UWP/GDK) build of Minecraft Bedrock.
