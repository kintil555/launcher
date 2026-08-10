using System.Diagnostics;
using Avalonia.Controls;
using Avalonia.Platform.Storage;
using EnderClient.Launcher.Services;

namespace EnderClient.Launcher.Views;

public partial class DirectoryView : UserControl
{
    public DirectoryView()
    {
        InitializeComponent();
        OpenFolderButton.Click += (_, _) => OpenFolder();
        ChangeFolderButton.Click += async (_, _) => await ChangeFolderAsync();
        Refresh();
    }

    public void Refresh()
    {
        DirectoryText.Text = AppServices.Settings.Settings.LauncherDirectory;
        StatusText.Text = string.Empty;
    }

    void OpenFolder()
    {
        var dir = AppServices.Settings.Settings.LauncherDirectory;
        Directory.CreateDirectory(dir);

        Process.Start(new ProcessStartInfo
        {
            FileName = "explorer.exe",
            Arguments = $"\"{dir}\"",
            UseShellExecute = true
        });
    }

    async Task ChangeFolderAsync()
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel is null) return;

        var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "Select launcher directory",
            AllowMultiple = false
        });

        var folder = folders.FirstOrDefault();
        var path = folder?.TryGetLocalPath();
        if (path is null) return;

        AppServices.Settings.SetLauncherDirectory(path);
        Refresh();
        StatusText.Text = "Directory updated.";
    }
}
