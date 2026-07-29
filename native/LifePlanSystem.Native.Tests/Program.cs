using LifePlanSystem.Native.Persistence;
using LifePlanSystem.Native.Contracts;
using LifePlanSystem.Native.Security;
using LifePlanSystem.Native.Providers;
using LifePlanSystem.Native.Recovery;
using Microsoft.Data.Sqlite;

var root = Path.Combine(Path.GetTempPath(), "lps-native-db-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var path = Path.Combine(root, "copied-profile.sqlite");
try
{
    if (!WebViewSecurityPolicy.IsTrustedMainUri("http://127.0.0.1:4177/#chat")
        || WebViewSecurityPolicy.IsTrustedMainUri("https://provider.example/")
        || WebViewSecurityPolicy.IsPermittedMainMessage("http://127.0.0.1:4177", "{\"action\":\"anything\"}"))
        throw new InvalidOperationException("Main WebView security policy did not deny untrusted capability use.");

    var capabilityStore = new ProviderCapabilityStore();
    var providerOrigin = new Uri("https://provider.example");
    var capability = capabilityStore.Issue("provider-a", providerOrigin, "capture-response", TimeSpan.FromMinutes(1));
    if (!capabilityStore.TryConsume(capability.Token, "provider-a", providerOrigin, "capture-response", DateTimeOffset.UtcNow)
        || capabilityStore.TryConsume(capability.Token, "provider-a", providerOrigin, "capture-response", DateTimeOffset.UtcNow))
        throw new InvalidOperationException("Provider capability was not one-use.");
    var wrongOrigin = capabilityStore.Issue("provider-a", providerOrigin, "capture-response", TimeSpan.FromMinutes(1));
    if (capabilityStore.TryConsume(wrongOrigin.Token, "provider-a", new Uri("https://evil.example"), "capture-response", DateTimeOffset.UtcNow))
        throw new InvalidOperationException("Provider capability accepted a different origin.");

    var providers = new ProviderPolicyRegistry();
    if (!providers.IsAllowedNavigation("chatgpt", new Uri("https://chatgpt.com/"))
        || providers.IsAllowedNavigation("chatgpt", new Uri("https://evil.example/"))
        || !providers.TryGet("chatgpt", out var chatGpt)
        || chatGpt!.CaptureMode != ProviderCaptureMode.UserReviewedPasteOnly)
        throw new InvalidOperationException("Provider policy did not enforce manual, allow-listed handling.");

    var database = new NativeDatabase(path);
    await database.MigrateAsync(CancellationToken.None);
    await database.MigrateAsync(CancellationToken.None);

    await database.InTransactionAsync(async (connection, transaction, cancellationToken) =>
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "CREATE TABLE transaction_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)";
        await command.ExecuteNonQueryAsync(cancellationToken);
        return 0;
    }, CancellationToken.None);

    await using (var verify = new SqliteConnection($"Data Source={path};Foreign Keys=True;Pooling=False"))
    {
        await verify.OpenAsync();
        await using var count = verify.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM native_schema_migrations WHERE id = 'native-contracts-v1'";
        if (Convert.ToInt32(await count.ExecuteScalarAsync()) != 1) throw new InvalidOperationException("Migration was not idempotent.");
    }

    await database.InTransactionAsync(async (connection, transaction, cancellationToken) =>
    {
        foreach (var sql in new[]
        {
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, status TEXT NOT NULL)",
            "CREATE TABLE knowledge_items (id INTEGER PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL)",
            "CREATE TABLE memory_candidates (id INTEGER PRIMARY KEY)"
        })
        {
            await using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        await using var seed = connection.CreateCommand();
        seed.Transaction = transaction;
        seed.CommandText = """
            INSERT INTO projects (status) VALUES ('active'), ('archived');
            INSERT INTO knowledge_items (type, status) VALUES ('blocker', 'active'), ('goal', 'review');
            INSERT INTO memory_candidates DEFAULT VALUES;
            """;
        await seed.ExecuteNonQueryAsync(cancellationToken);
        return 0;
    }, CancellationToken.None);

    var status = await new RuntimeStatusReader(path).ReadAsync(CancellationToken.None);
    if (status is not { DatabaseReady: true, ActiveProjects: 1, BlockedItems: 1, ReviewItems: 1, MemoryCandidates: 1 })
        throw new InvalidOperationException("Native runtime status contract did not match fixture.");

    var backupRoot = Path.Combine(root, "backups");
    var backup = await new NativeBackupService().CreateAndVerifyAsync(path, backupRoot, CancellationToken.None);
    if (!File.Exists(backup.BackupPath) || backup.Sha256.Length != 64)
        throw new InvalidOperationException("Native backup evidence was not created.");
    Console.WriteLine("PASS native SQLite migration and transaction contract");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
}
