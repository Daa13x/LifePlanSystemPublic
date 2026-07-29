using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;

namespace LifePlanSystem.Native.Runtime;

internal sealed class NativeHealthService(NativeRuntimeIdentity identity) : BackgroundService
{
    private readonly HttpListener _listener = new();

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
            if (_listener.IsListening) _listener.Stop();
            _listener.Close();
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

        var body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            ok = true,
            data = new
            {
                runtime = identity,
                db = "compatibility-not-owned",
                node = "compatibility-host"
            }
        });
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength64 = body.Length;
        await context.Response.OutputStream.WriteAsync(body, cancellationToken);
        context.Response.Close();
    }
}
