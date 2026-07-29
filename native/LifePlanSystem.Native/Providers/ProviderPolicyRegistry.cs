namespace LifePlanSystem.Native.Providers;

public enum ProviderAuthMode { OfficialApi, SystemBrowserOAuth, BrowserAssistedManual }
public enum ProviderCaptureMode { OfficialApiResponse, UserReviewedPasteOnly }

public sealed record ProviderPolicy(
    string Id,
    ProviderAuthMode AuthMode,
    ProviderCaptureMode CaptureMode,
    IReadOnlySet<string> AllowedHosts);

public sealed class ProviderPolicyRegistry
{
    private static readonly IReadOnlyDictionary<string, ProviderPolicy> Policies =
        new Dictionary<string, ProviderPolicy>(StringComparer.OrdinalIgnoreCase)
        {
            ["chatgpt"] = new("chatgpt", ProviderAuthMode.BrowserAssistedManual, ProviderCaptureMode.UserReviewedPasteOnly,
                new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "chatgpt.com", "auth.openai.com" }),
            ["gemini"] = new("gemini", ProviderAuthMode.BrowserAssistedManual, ProviderCaptureMode.UserReviewedPasteOnly,
                new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "gemini.google.com", "accounts.google.com" }),
            ["claude"] = new("claude", ProviderAuthMode.BrowserAssistedManual, ProviderCaptureMode.UserReviewedPasteOnly,
                new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "claude.ai" }),
            ["grok"] = new("grok", ProviderAuthMode.BrowserAssistedManual, ProviderCaptureMode.UserReviewedPasteOnly,
                new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "grok.com", "x.com" })
        };

    public bool TryGet(string providerId, out ProviderPolicy? policy) => Policies.TryGetValue(providerId, out policy);

    public bool IsAllowedNavigation(string providerId, Uri uri)
    {
        return TryGet(providerId, out var policy)
            && uri.Scheme == Uri.UriSchemeHttps
            && policy!.AllowedHosts.Any(host => uri.Host.Equals(host, StringComparison.OrdinalIgnoreCase)
                || uri.Host.EndsWith("." + host, StringComparison.OrdinalIgnoreCase));
    }
}
