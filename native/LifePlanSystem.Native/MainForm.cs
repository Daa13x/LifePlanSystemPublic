using Microsoft.Web.WebView2.WinForms;
using LifePlanSystem.Native.Security;
using LifePlanSystem.Native.Providers;
using System.Text.Json;

namespace LifePlanSystem.Native;

internal sealed class MainForm : Form
{
    private readonly NativeRuntimeIdentity _identity;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private ProviderWindowForm? _chatGptWindow;

    public MainForm(NativeRuntimeIdentity identity)
    {
        _identity = identity;
        Text = $"Life Planner ({_identity.RuntimeMode})";
        MinimumSize = new Size(1024, 720);
        Controls.Add(_webView);
        Shown += OnShown;
        FormClosing += (_, _) =>
        {
            _chatGptWindow?.Close();
            _webView.Dispose();
        };
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
                HandleMainMessage(message.Source, message.TryGetWebMessageAsString());
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

    private void HandleMainMessage(string source, string rawMessage)
    {
        // This is a presentation-only command from the trusted local shell.
        // It takes no URL, prompt, browser data, or capture instruction: the
        // native provider policy owns the only destination that can open.
        if (!WebViewSecurityPolicy.IsTrustedMainUri(source)) return;
        try
        {
            using var document = JsonDocument.Parse(rawMessage);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("type", out var type)
                || !StringComparer.Ordinal.Equals(type.GetString(), "open-provider-window")
                || !root.TryGetProperty("provider", out var provider)
                || !StringComparer.Ordinal.Equals(provider.GetString(), "chatgpt")) return;

            OpenChatGptWindow();
        }
        catch (JsonException)
        {
            // Ignore malformed untrusted messages from the renderer.
        }
    }

    private void OpenChatGptWindow()
    {
        if (_chatGptWindow is { IsDisposed: false })
        {
            _chatGptWindow.Show();
            _chatGptWindow.BringToFront();
            return;
        }

        _chatGptWindow = new ProviderWindowForm("chatgpt", new ProviderPolicyRegistry());
        _chatGptWindow.FormClosed += (_, _) => _chatGptWindow = null;
        _chatGptWindow.Show(this);
    }
}
