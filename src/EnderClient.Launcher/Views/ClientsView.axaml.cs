using Avalonia;
using Avalonia.Controls;
using Avalonia.Platform.Storage;
using EnderClient.Core.Models;
using EnderClient.Launcher.Services;

namespace EnderClient.Launcher.Views;

public partial class ClientsView : UserControl
{
    public ClientsView()
    {
        InitializeComponent();
        AddClientButton.Click += async (_, _) => await AddClientAsync();
        Refresh();
    }

    public void Refresh()
    {
        ClientListPanel.Children.Clear();

        foreach (var entry in AppServices.Settings.Settings.Clients)
        {
            var row = new ClientRow();
            row.SetEntry(entry);
            row.RemoveRequested += RemoveClient;
            ClientListPanel.Children.Add(row);
        }

        if (ClientListPanel.Children.Count == 0)
        {
            ClientListPanel.Children.Add(new TextBlock
            {
                Text = "No clients added yet.",
                Foreground = (Avalonia.Media.IBrush)Application.Current!.Resources["MutedForegroundBrush"]!
            });
        }
    }

    async Task AddClientAsync()
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel is null) return;

        var files = await topLevel.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Select client DLL",
            AllowMultiple = false,
            FileTypeFilter = new[] { new FilePickerFileType("Client DLL") { Patterns = new[] { "*.dll" } } }
        });

        var file = files.FirstOrDefault();
        if (file is null) return;

        var path = file.TryGetLocalPath();
        if (path is null) return;

        var name = Path.GetFileNameWithoutExtension(path);

        // Avoid duplicate names by suffixing.
        var settings = AppServices.Settings.Settings;
        var finalName = name;
        var suffix = 2;
        while (settings.Clients.Any(c => c.Name == finalName))
            finalName = $"{name} ({suffix++})";

        settings.Clients.Add(new ClientEntry { Name = finalName, DllPath = path });
        AppServices.Settings.Save();

        Refresh();
    }

    void RemoveClient(ClientEntry entry)
    {
        var settings = AppServices.Settings.Settings;
        settings.Clients.Remove(entry);

        if (settings.SelectedClientName == entry.Name)
            settings.SelectedClientName = null;

        AppServices.Settings.Save();
        Refresh();
    }
}
