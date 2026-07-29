using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using LifePlanSystem.Native.Contracts;

namespace LifePlanSystem.Native.Runtime;

internal sealed class NativeHealthService(NativeRuntimeIdentity identity, NativeReadProfileLocator profileLocator) : BackgroundService
{
    private readonly HttpListener _listener = new();

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        if (_listener.IsListening) _listener.Close();
        await base.StopAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _listener.Prefixes.Add("http://127.0.0.1:4178/native/");
        _listener.Start();
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var context = await _listener.GetContextAsync().WaitAsync(stoppingToken);
                await WriteAsync(context, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            if (_listener.IsListening) _listener.Close();
        }
    }

    private async Task WriteAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        if (!context.Request.Url?.AbsolutePath.Equals("/native/health", StringComparison.OrdinalIgnoreCase) ?? true)
        {
            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            context.Response.Close();
            return;
        }

        var workboard = await ReadWorkboardAsync(cancellationToken);
        var body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            ok = true,
            data = new
            {
                runtime = identity,
                db = workboard.Status,
                workboard = workboard.Value,
                node = "compatibility-host"
            }
        });
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength64 = body.Length;
        await context.Response.OutputStream.WriteAsync(body, cancellationToken);
        context.Response.Close();
    }

    private async Task<(string Status, RuntimeStatus? Value)> ReadWorkboardAsync(CancellationToken cancellationToken)
    {
        var databasePath = profileLocator.TryLocateDatabase();
        if (databasePath is null) return ("compatibility-no-profile", null);
        try
        {
            var status = await new RuntimeStatusReader(databasePath).ReadAsync(cancellationToken);
            return ("compatibility-read-only", status);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            // Do not disclose paths, SQL errors, or data through an unauthenticated loopback probe.
            return ("compatibility-read-unavailable", null);
        }
    }
}
