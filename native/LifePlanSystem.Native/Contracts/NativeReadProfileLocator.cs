namespace LifePlanSystem.Native.Contracts;

/// <summary>
/// Resolves only the companion package's established local SQLite profile.
/// This deliberately has no environment override: the native compatibility
/// shell must not be pointed at arbitrary files by a renderer or provider.
/// </summary>
public sealed class NativeReadProfileLocator
{
    private readonly string _profileDirectory;

    public NativeReadProfileLocator(string nativeBaseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(nativeBaseDirectory);
        _profileDirectory = Path.GetFullPath(Path.Combine(nativeBaseDirectory, "..", "app", "data"));
    }

    public string? TryLocateDatabase()
    {
        var candidate = Path.GetFullPath(Path.Combine(_profileDirectory, "life-planner.sqlite"));
        var boundary = _profileDirectory.EndsWith(Path.DirectorySeparatorChar)
            ? _profileDirectory
            : _profileDirectory + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(boundary, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Native profile resolution escaped its package boundary.");
        return File.Exists(candidate) ? candidate : null;
    }
}
