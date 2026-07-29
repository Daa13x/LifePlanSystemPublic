using System.Text.Json;
using System.Security.Cryptography;

namespace LifePlanSystem.Native.Security;

public sealed record ValidatedNativeCommand(string Type, Guid CorrelationId, JsonElement Payload);
public sealed record NativeCommandCapability(string Token, Uri Origin, string Type, DateTimeOffset ExpiresAt);

/// <summary>
/// Strict parser for the future main-view command boundary. Consumers must use
/// the finite command list below; this is intentionally separate from provider
/// page messaging and currently has no dispatch registration.
/// </summary>
public sealed class NativeCommandEnvelopeValidator
{
    private const string MainShell = "main-shell";
    private static readonly HashSet<string> AllowedTypes = new(StringComparer.Ordinal)
    {
        "create-project"
    };
    private readonly Dictionary<string, NativeCommandCapability> _capabilities = new(StringComparer.Ordinal);

    public bool TryValidate(string source, string rawMessage, DateTimeOffset now, out ValidatedNativeCommand? command)
    {
        command = null;
        if (!WebViewSecurityPolicy.IsTrustedMainUri(source)) return false;
        try
        {
            using var document = JsonDocument.Parse(rawMessage);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("version", out var version) || version.GetInt32() != 1
                || !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String
                || !AllowedTypes.Contains(type.GetString()!)
                || !root.TryGetProperty("correlationId", out var correlation) || !Guid.TryParse(correlation.GetString(), out var correlationId)
                || !root.TryGetProperty("expiresAt", out var expiry) || !DateTimeOffset.TryParse(expiry.GetString(), out var expiresAt)
                || expiresAt <= now || expiresAt > now.AddMinutes(5)
                || !root.TryGetProperty("capability", out var capability) || capability.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
                return false;

            var origin = new Uri(source, UriKind.Absolute);
            if (!TryConsume(capability.GetString()!, origin, type.GetString()!, now)) return false;
            command = new ValidatedNativeCommand(type.GetString()!, correlationId, payload.Clone());
            return true;
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or FormatException or ArgumentException)
        {
            return false;
        }
    }

    public NativeCommandCapability IssueForTesting(Uri localOrigin, string type, TimeSpan lifetime)
    {
        if (!WebViewSecurityPolicy.IsTrustedMainUri(localOrigin.AbsoluteUri) || !AllowedTypes.Contains(type))
            throw new ArgumentException("Only an allow-listed main-shell command may receive a capability.");
        if (lifetime <= TimeSpan.Zero || lifetime > TimeSpan.FromMinutes(5))
            throw new ArgumentOutOfRangeException(nameof(lifetime));
        var capability = new NativeCommandCapability(
            Convert.ToHexString(RandomNumberGenerator.GetBytes(32)), localOrigin, type, DateTimeOffset.UtcNow.Add(lifetime));
        _capabilities.Add(capability.Token, capability);
        return capability;
    }

    private bool TryConsume(string token, Uri origin, string type, DateTimeOffset now)
    {
        if (!_capabilities.Remove(token, out var capability)) return false;
        return capability.ExpiresAt > now
            && StringComparer.Ordinal.Equals(capability.Type, type)
            && Uri.Compare(capability.Origin, origin, UriComponents.SchemeAndServer, UriFormat.SafeUnescaped, StringComparison.OrdinalIgnoreCase) == 0;
    }
}
