using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using EnderClient.Core.Game;
using EnderClient.Core.Models;
using EnderClient.Launcher.Services;

namespace EnderClient.Launcher.Views;

public partial class HomeView : UserControl
{
    const string VanillaOption = "Vanilla (no client)";
    const double MaxYaw = 0.55;   // radians, ~31.5deg either side
    const double MaxPitch = 0.35; // radians, ~20deg either side

    public HomeView()
    {
        InitializeComponent();

        PopulateClients();
        LoadSkin();

        ClientSelector.SelectionChanged += (_, _) => SaveSelection();
        LaunchButton.Click += async (_, _) => await LaunchAsync();

        PointerMoved += OnPointerMoved;
        PointerExited += (_, _) => ResetHeadPose();
    }

    void LoadSkin()
    {
        try
        {
            var skinPath = SkinLocator.FindActiveSkinPath();

            HeadView.Skin = skinPath is not null
                ? new Bitmap(skinPath)
                : new Bitmap(AssetLoader.Open(new Uri("avares://EnderClient.Launcher/Assets/steve_default.png")));
        }
        catch
        {
            // Corrupt or unreadable skin file — fall back to the bundled default so the
            // head still renders instead of staying blank.
            HeadView.Skin = new Bitmap(AssetLoader.Open(new Uri("avares://EnderClient.Launcher/Assets/steve_default.png")));
        }
    }

    void OnPointerMoved(object? sender, PointerEventArgs e)
    {
        var bounds = HeadView.Bounds;
        if (bounds.Width <= 0 || bounds.Height <= 0) return;

        var pos = e.GetPosition(HeadView);

        // Normalize to [-1, 1] relative to the head control's center, then clamp so the
        // head only turns within a natural-looking range instead of spinning wildly.
        var nx = Math.Clamp((pos.X - bounds.Width / 2) / (bounds.Width / 2), -1, 1);
        var ny = Math.Clamp((pos.Y - bounds.Height / 2) / (bounds.Height / 2), -1, 1);

        HeadView.Yaw = nx * MaxYaw;
        HeadView.Pitch = -ny * MaxPitch;
    }

    void ResetHeadPose()
    {
        HeadView.Yaw = 0;
        HeadView.Pitch = 0;
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
