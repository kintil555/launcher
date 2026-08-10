using Avalonia.Controls;
using EnderClient.Core.Models;

namespace EnderClient.Launcher.Views;

public partial class ClientRow : UserControl
{
    public event Action<ClientEntry>? RemoveRequested;

    ClientEntry _entry = null!;

    public ClientRow()
    {
        InitializeComponent();
        RemoveButton.Click += (_, _) => RemoveRequested?.Invoke(_entry);
    }

    public void SetEntry(ClientEntry entry)
    {
        _entry = entry;
        NameText.Text = entry.Name;
        PathText.Text = entry.DllPath;
    }
}
