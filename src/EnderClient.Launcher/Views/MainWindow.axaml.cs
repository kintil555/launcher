using Avalonia.Controls;

namespace EnderClient.Launcher.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();

        HomeNav.IsCheckedChanged += (_, _) => UpdatePage();
        ClientsNav.IsCheckedChanged += (_, _) => UpdatePage();
        DirectoryNav.IsCheckedChanged += (_, _) => UpdatePage();

        // Directory tab reads the current setting each time it's shown.
        DirectoryNav.IsCheckedChanged += (_, _) =>
        {
            if (DirectoryNav.IsChecked == true)
                DirectoryPage.Refresh();
        };

        // Clients tab reloads its list each time it's shown, in case Directory changed.
        ClientsNav.IsCheckedChanged += (_, _) =>
        {
            if (ClientsNav.IsChecked == true)
                ClientsPage.Refresh();
        };
    }

    void UpdatePage()
    {
        HomePage.IsVisible = HomeNav.IsChecked == true;
        ClientsPage.IsVisible = ClientsNav.IsChecked == true;
        DirectoryPage.IsVisible = DirectoryNav.IsChecked == true;
    }
}
