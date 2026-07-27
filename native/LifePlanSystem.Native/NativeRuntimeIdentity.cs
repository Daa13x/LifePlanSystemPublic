using System.Reflection;

namespace LifePlanSystem.Native;

internal sealed record NativeRuntimeIdentity(string Version, string Commit, string RuntimeMode)
{
    public static NativeRuntimeIdentity Current()
    {
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";
        var commit = Environment.GetEnvironmentVariable("LPS_BUILD_COMMIT") ?? "development";
        return new NativeRuntimeIdentity(version, commit, "native-shell-compatibility");
    }
}
