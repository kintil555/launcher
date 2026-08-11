using System.Globalization;
using Avalonia.Controls;
using Avalonia.Input;
using EnderClient.Core.Game;
using EnderClient.Core.Models;
using EnderClient.Launcher.Services;

namespace EnderClient.Launcher.Views;

public partial class HomeView : UserControl
{
    const string VanillaOption = "Vanilla (no client)";
    const double MaxYaw = 0.55;   // radians, ~31.5deg either side
    const double MaxPitch = 0.35; // radians, ~20deg either side

    bool _headViewReady;

    public HomeView()
    {
        InitializeComponent();

        PopulateClients();

        ClientSelector.SelectionChanged += (_, _) => SaveSelection();
        LaunchButton.Click += async (_, _) => await LaunchAsync();

        PointerMoved += OnPointerMoved;
        PointerExited += (_, _) => ResetHeadPose();

        var headHtmlPath = Path.Combine(AppContext.BaseDirectory, "Assets", "Web", "head.html");
        HeadView.Source = new Uri(headHtmlPath);
    }

    async void OnHeadViewNavigationCompleted(object? sender, WebViewNavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess) return;

        _headViewReady = true;

        var skinPath = SkinLocator.FindActiveSkinPath();
        if (skinPath is not null)
        {
            // file:// URI with forward slashes, as expected by the browser engine.
            var uri = new Uri(skinPath).AbsoluteUri;
            await HeadView.InvokeScript($"setSkin('{uri}')");
        }
    }

    void OnPointerMoved(object? sender, PointerEventArgs e)
    {
        if (!_headViewReady) return;

        var bounds = HeadView.Bounds;
        if (bounds.Width <= 0 || bounds.Height <= 0) return;

        var pos = e.GetPosition(HeadView);

        var nx = Math.Clamp((pos.X - bounds.Width / 2) / (bounds.Width / 2), -1, 1);
        var ny = Math.Clamp((pos.Y - bounds.Height / 2) / (bounds.Height / 2), -1, 1);

        var yaw = nx * MaxYaw;
        var pitch = -ny * MaxPitch;

        _ = HeadView.InvokeScript(
            $"setYawPitch({yaw.ToString(CultureInfo.InvariantCulture)}, {pitch.ToString(CultureInfo.InvariantCulture)})");
    }

    void ResetHeadPose()
    {
        if (!_headViewReady) return;
        _ = HeadView.InvokeScript("setYawPitch(0, 0)");
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
