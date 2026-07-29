using System.Security.Cryptography;

namespace LifePlanSystem.Native.Security;

public sealed record ProviderCapability(string Token, string ProviderId, Uri Origin, string Action, DateTimeOffset ExpiresAt);

public sealed class ProviderCapabilityStore
{
    private readonly Dictionary<string, ProviderCapability> _capabilities = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public ProviderCapability Issue(string providerId, Uri origin, string action, TimeSpan lifetime)
    {
        if (String.IsNullOrWhiteSpace(providerId)) throw new ArgumentException("Provider ID is required.", nameof(providerId));
        if (!origin.IsAbsoluteUri || origin.Scheme != Uri.UriSchemeHttps) throw new ArgumentException("Provider origin must be HTTPS.", nameof(origin));
        if (String.IsNullOrWhiteSpace(action)) throw new ArgumentException("Action is required.", nameof(action));
        if (lifetime <= TimeSpan.Zero || lifetime > TimeSpan.FromMinutes(5)) throw new ArgumentOutOfRangeException(nameof(lifetime));

        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var capability = new ProviderCapability(token, providerId, origin, action, DateTimeOffset.UtcNow.Add(lifetime));
        lock (_gate) _capabilities.Add(token, capability);
        return capability;
    }

    public bool TryConsume(string token, string providerId, Uri origin, string action, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (!_capabilities.Remove(token, out var capability)) return false;
            return capability.ExpiresAt >= now
                && capability.ProviderId.Equals(providerId, StringComparison.Ordinal)
                && capability.Action.Equals(action, StringComparison.Ordinal)
                && Uri.Compare(capability.Origin, origin, UriComponents.SchemeAndServer, UriFormat.SafeUnescaped, StringComparison.OrdinalIgnoreCase) == 0;
        }
    }

    public void RevokeAllForProvider(string providerId)
    {
        lock (_gate)
        {
            foreach (var token in _capabilities.Where(pair => pair.Value.ProviderId.Equals(providerId, StringComparison.Ordinal)).Select(pair => pair.Key).ToArray())
                _capabilities.Remove(token);
        }
    }
}
