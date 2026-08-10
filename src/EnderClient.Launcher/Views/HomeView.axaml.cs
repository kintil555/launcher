using Avalonia.Controls;
using Avalonia.Threading;
using EnderClient.Core.Game;
using EnderClient.Core.Models;
using EnderClient.Launcher.Services;

namespace EnderClient.Launcher.Views;

public partial class HomeView : UserControl
{
    const string VanillaOption = "Vanilla (no client)";

    public HomeView()
    {
        InitializeComponent();

        PopulateClients();
        ClientSelector.SelectionChanged += (_, _) => SaveSelection();
        LaunchButton.Click += async (_, _) => await LaunchAsync();
    }

    void PopulateClients()
    {
        var settings = AppServices.Settings.Settings;

        var items = new List<string> { VanillaOption };
        items.AddRange(settings.Clients.Where(c => c.IsValid).Select(c => c.Name));
        ClientSelector.ItemsSource = items;

        var selected = settings.SelectedClientName;
        ClientSelector.SelectedItem = selected is not null && items.Contains(selected) ? selected : VanillaOption;
    }

    void SaveSelection()
    {
        var name = ClientSelector.SelectedItem as string;
        AppServices.Settings.Settings.SelectedClientName = name == VanillaOption ? null : name;
        AppServices.Settings.Save();
    }

    async Task LaunchAsync()
    {
        LaunchButton.IsEnabled = false;
        StatusText.Text = "Launching...";

        try
        {
            var selectedName = AppServices.Settings.Settings.SelectedClientName;
            ClientEntry? client = selectedName is null
                ? null
                : AppServices.Settings.Settings.Clients.FirstOrDefault(c => c.Name == selectedName);

            await GameLauncher.LaunchAsync(client?.DllPath);

            StatusText.Text = client is not null
                ? $"Launched with {client.Name}."
                : "Launched.";
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Failed: {ex.Message}";
        }
        finally
        {
            LaunchButton.IsEnabled = true;
        }
    }
}
