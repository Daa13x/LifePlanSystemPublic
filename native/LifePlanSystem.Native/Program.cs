using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using LifePlanSystem.Native.Runtime;

namespace LifePlanSystem.Native;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        using var instance = SingleInstanceGate.TryAcquire();
        if (instance is null)
        {
            MessageBox.Show("Life Planner is already running.", "Life Planner", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        var builder = Host.CreateApplicationBuilder();
        builder.Services.AddSingleton(NativeRuntimeIdentity.Current());
        builder.Services.AddHostedService<NativeHealthService>();
        builder.Services.AddSingleton<MainForm>();
        using var host = builder.Build();
        host.Start();
        try
        {
            if (args.Contains("--health-smoke", StringComparer.Ordinal))
            {
                Thread.Sleep(TimeSpan.FromSeconds(10));
                return;
            }
            Application.Run(host.Services.GetRequiredService<MainForm>());
        }
        finally
        {
            host.StopAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
        }
    }
}
