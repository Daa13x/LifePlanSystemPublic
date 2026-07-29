using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LifePlanSystem.Native.Providers;

/// <summary>
/// A visibly separate, persistent-profile provider surface. It is deliberately
/// not the main LPS WebView: provider pages cannot send native commands, no
/// provider content is captured, and navigation never leaves the allow-listed
/// HTTPS hosts for the selected provider.
/// </summary>
internal sealed class ProviderWindowForm : Form
{
    private readonly string _providerId;
    private readonly ProviderPolicyRegistry _policies;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly Label _status = new() { AutoSize = true, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };

    public ProviderWindowForm(string providerId, ProviderPolicyRegistry policies)
    {
        _providerId = providerId;
        _policies = policies;
        Text = "Life Planner — ChatGPT";
        MinimumSize = new Size(760, 620);
        Size = new Size(980, 760);
        StartPosition = FormStartPosition.CenterParent;

        var header = new Panel { Dock = DockStyle.Top, Height = 42, Padding = new Padding(12, 7, 12, 7) };
        _status.Text = "ChatGPT uses an isolated local browser profile. Signing in here does not send any Life Planner data.";
        header.Controls.Add(_status);
        Controls.Add(_webView);
        Controls.Add(header);
        Shown += OnShown;
        FormClosing += (_, _) => _webView.Dispose();
    }

    private async void OnShown(object? sender, EventArgs args)
    {
        if (!_policies.TryGet(_providerId, out var policy) || policy is null)
        {
            Close();
            return;
        }

        try
        {
            var profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Life Planner", "webview", "providers", _providerId);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            await _webView.EnsureCoreWebView2Async(environment);
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.WebMessageReceived += (_, _) => { /* Provider pages have no native message channel. */ };
            _webView.CoreWebView2.NavigationStarting += (_, navigation) =>
            {
                if (!_policies.IsAllowedNavigation(_providerId, new Uri(navigation.Uri)))
                {
                    navigation.Cancel = true;
                    _status.Text = "Blocked a provider navigation outside the ChatGPT allow-list.";
                }
            };
            _webView.CoreWebView2.NewWindowRequested += (_, popup) =>
            {
                if (Uri.TryCreate(popup.Uri, UriKind.Absolute, out var destination) && _policies.IsAllowedNavigation(_providerId, destination))
                {
                    popup.Handled = true;
                    _webView.CoreWebView2.Navigate(destination.AbsoluteUri);
                }
                else
                {
                    popup.Handled = true;
                    _status.Text = "Blocked a provider popup outside the ChatGPT allow-list.";
                }
            };
            _webView.CoreWebView2.PermissionRequested += (_, permission) =>
            {
                permission.State = CoreWebView2PermissionState.Deny;
                _status.Text = "Blocked a ChatGPT permission request in the isolated provider window.";
            };
            _webView.CoreWebView2.DownloadStarting += (_, download) =>
            {
                download.Cancel = true;
                _status.Text = "Blocked a download from the isolated provider window.";
            };
            _webView.Source = new Uri("https://chatgpt.com/");
        }
        catch (Exception exception)
        {
            _status.Text = "ChatGPT could not open in the provider window.";
            MessageBox.Show($"ChatGPT could not initialize its isolated provider view.{Environment.NewLine}{exception.Message}",
                "Life Planner", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
