using System.Reflection;

namespace LifePlanSystem.Native;

internal sealed record NativeRuntimeIdentity(string Version, string Commit, string RuntimeMode)
{
    public static NativeRuntimeIdentity Current()
    {
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";
        var commit = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => attribute.Key == "LpsBuildCommit")?.Value;
        if (string.IsNullOrWhiteSpace(commit)) commit = "unknown";
        return new NativeRuntimeIdentity(version, commit, "native-shell");
    }
}
