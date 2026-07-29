using System.Security.Cryptography;
using System.Text;

namespace LifePlanSystem.Native.Providers;

/// <summary>Current-user DPAPI storage for native provider credentials. Secrets never enter SQLite or logs.</summary>
public sealed class ProviderSecretStore(string directory)
{
    public void Save(string providerId, string secret)
    {
        if (string.IsNullOrWhiteSpace(providerId) || string.IsNullOrWhiteSpace(secret)) throw new ArgumentException("Provider and secret are required.");
        Directory.CreateDirectory(directory);
        var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(providerId), DataProtectionScope.CurrentUser);
        File.WriteAllBytes(Path.Combine(directory, SafeName(providerId) + ".bin"), encrypted);
    }
    public string? Read(string providerId)
    {
        var path = Path.Combine(directory, SafeName(providerId) + ".bin");
        if (!File.Exists(path)) return null;
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(path), Encoding.UTF8.GetBytes(providerId), DataProtectionScope.CurrentUser));
    }
    public void Remove(string providerId) { var path = Path.Combine(directory, SafeName(providerId) + ".bin"); if (File.Exists(path)) File.Delete(path); }
    private static string SafeName(string id) => string.Concat(id.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_'));
}
