namespace LifePlanSystem.Native.Security;

public static class WebViewSecurityPolicy
{
    public static bool IsTrustedMainUri(string? rawUri)
    {
        return Uri.TryCreate(rawUri, UriKind.Absolute, out var uri)
            && uri.Scheme == Uri.UriSchemeHttp
            && uri.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            && uri.Port == 4177;
    }

    public static bool IsPermittedMainMessage(string? source, string? payload)
    {
        // The compatibility view has no native command surface. This denial is
        // intentional until a versioned, capability-bound schema is introduced.
        return false;
    }
}
