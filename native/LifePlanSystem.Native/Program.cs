using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace LifePlanSystem.Native;

internal static class Program
{
    [STAThread]
    private static void Main()
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
        builder.Services.AddSingleton<MainForm>();
        using var host = builder.Build();
        host.Start();
        try
        {
            Application.Run(host.Services.GetRequiredService<MainForm>());
        }
        finally
        {
            host.StopAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
        }
    }
}
