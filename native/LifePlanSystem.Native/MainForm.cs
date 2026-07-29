using Microsoft.Web.WebView2.WinForms;
using LifePlanSystem.Native.Security;

namespace LifePlanSystem.Native;

internal sealed class MainForm : Form
{
    private readonly NativeRuntimeIdentity _identity;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };

    public MainForm(NativeRuntimeIdentity identity)
    {
        _identity = identity;
        Text = $"Life Planner ({_identity.RuntimeMode})";
        MinimumSize = new Size(1024, 720);
        Controls.Add(_webView);
        Shown += OnShown;
        FormClosing += (_, _) => _webView.Dispose();
    }

    private async void OnShown(object? sender, EventArgs args)
    {
        try
        {
            var profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Life Planner", "webview", "main");
            var environment = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            await _webView.EnsureCoreWebView2Async(environment);
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.NewWindowRequested += (_, popup) => popup.Handled = true;
            _webView.CoreWebView2.PermissionRequested += (_, permission) => permission.State =
                Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Deny;
            _webView.CoreWebView2.WebMessageReceived += (_, message) =>
            {
                if (!WebViewSecurityPolicy.IsPermittedMainMessage(message.Source, message.TryGetWebMessageAsString()))
                    return;
            };
            _webView.CoreWebView2.NavigationStarting += (_, navigation) =>
            {
                if (!WebViewSecurityPolicy.IsTrustedMainUri(navigation.Uri))
                {
                    navigation.Cancel = true;
                }
            };
            _webView.Source = new Uri("http://127.0.0.1:4177/");
        }
        catch (Exception exception)
        {
            MessageBox.Show($"Life Planner could not initialize its native view.{Environment.NewLine}{exception.Message}",
                "Life Planner", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
