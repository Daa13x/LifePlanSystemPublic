using LifePlanSystem.Native.Persistence;
using LifePlanSystem.Native.Contracts;
using LifePlanSystem.Native.Security;
using LifePlanSystem.Native.Providers;
using LifePlanSystem.Native.Recovery;
using Microsoft.Data.Sqlite;
using System.Text.Json;

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

    var commandValidator = new NativeCommandEnvelopeValidator();
    var localOrigin = new Uri("http://127.0.0.1:4177/");
    var commandCapability = commandValidator.IssueForTesting(localOrigin, "create-project", TimeSpan.FromMinutes(1));
    var correlationId = Guid.NewGuid();
    var validEnvelope = JsonSerializer.Serialize(new
    {
        version = 1,
        type = "create-project",
        correlationId,
        expiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        capability = commandCapability.Token,
        payload = new { name = "Fixture" }
    });
    if (!commandValidator.TryValidate(localOrigin.AbsoluteUri, validEnvelope, DateTimeOffset.UtcNow, out var validatedCommand)
        || validatedCommand?.Type != "create-project"
        || commandValidator.TryValidate(localOrigin.AbsoluteUri, validEnvelope, DateTimeOffset.UtcNow, out _)
        || commandValidator.TryValidate(localOrigin.AbsoluteUri, "{\"version\":1,\"type\":\"unbounded\"}", DateTimeOffset.UtcNow, out _))
        throw new InvalidOperationException("Native command envelope did not enforce origin, schema and one-use capability validation.");
    if (commandValidator.TryValidate(localOrigin.AbsoluteUri, "{\"version\":\"not-an-integer\"}", DateTimeOffset.UtcNow, out _))
        throw new InvalidOperationException("Native command envelope accepted a malformed schema.");
    var wrongOriginCapability = commandValidator.IssueForTesting(localOrigin, "create-project", TimeSpan.FromMinutes(1));
    var wrongOriginEnvelope = JsonSerializer.Serialize(new
    {
        version = 1, type = "create-project", correlationId = Guid.NewGuid(), expiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        capability = wrongOriginCapability.Token, payload = new { name = "Fixture" }
    });
    var expiredCapability = commandValidator.IssueForTesting(localOrigin, "create-project", TimeSpan.FromMinutes(1));
    var expiredEnvelope = JsonSerializer.Serialize(new
    {
        version = 1, type = "create-project", correlationId = Guid.NewGuid(), expiresAt = DateTimeOffset.UtcNow.AddMinutes(-1),
        capability = expiredCapability.Token, payload = new { name = "Fixture" }
    });
    if (commandValidator.TryValidate("https://evil.example/", wrongOriginEnvelope, DateTimeOffset.UtcNow, out _)
        || commandValidator.TryValidate(localOrigin.AbsoluteUri, expiredEnvelope, DateTimeOffset.UtcNow, out _))
        throw new InvalidOperationException("Native command envelope accepted a hostile origin or expired message.");

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
            "CREATE TABLE approvals (id INTEGER PRIMARY KEY, status TEXT NOT NULL)",
            "CREATE TABLE memory_candidates (id INTEGER PRIMARY KEY, status TEXT NOT NULL)"
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
            INSERT INTO projects (status) VALUES ('active'), ('stable'), ('done'), ('completed'), ('archived');
            INSERT INTO knowledge_items (type, status) VALUES ('blocker', 'blocked'), ('goal', 'blocked'), ('blocker', 'archived'), ('goal', 'active');
            INSERT INTO approvals (status) VALUES ('pending'), ('approved');
            INSERT INTO memory_candidates (status) VALUES ('candidate'), ('deferred'), ('approved');
            """;
        await seed.ExecuteNonQueryAsync(cancellationToken);
        return 0;
    }, CancellationToken.None);

    var status = await new RuntimeStatusReader(path).ReadAsync(CancellationToken.None);
    if (status is not { DatabaseReady: true, ActiveProjects: 2, BlockedItems: 2, ReviewItems: 1, MemoryCandidates: 2 })
        throw new InvalidOperationException("Native runtime status contract did not match fixture.");

    var backupRoot = Path.Combine(root, "backups");
    var backup = await new NativeBackupService().CreateAndVerifyAsync(path, backupRoot, CancellationToken.None);
    if (!File.Exists(backup.BackupPath) || backup.Sha256.Length != 64)
        throw new InvalidOperationException("Native backup evidence was not created.");

    var companionRoot = Path.Combine(root, "companion");
    var nativeRoot = Path.Combine(companionRoot, "native");
    var dataRoot = Path.Combine(companionRoot, "app", "data");
    Directory.CreateDirectory(nativeRoot);
    Directory.CreateDirectory(dataRoot);
    var packagedProfile = Path.Combine(dataRoot, "life-planner.sqlite");
    File.Copy(path, packagedProfile);
    var locatedProfile = new NativeReadProfileLocator(nativeRoot).TryLocateDatabase();
    if (!StringComparer.OrdinalIgnoreCase.Equals(locatedProfile, packagedProfile))
        throw new InvalidOperationException("Native companion profile locator did not resolve only the package data profile.");

    var commandPath = Path.Combine(root, "command-profile.sqlite");
    await using (var commandFixture = new SqliteConnection($"Data Source={commandPath};Pooling=False"))
    {
        await commandFixture.OpenAsync();
        await using var schema = commandFixture.CreateCommand();
        schema.CommandText = """
            CREATE TABLE projects (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              status TEXT NOT NULL,
              owner TEXT NOT NULL,
              source TEXT NOT NULL,
              confidence REAL NOT NULL,
              last_reviewed TEXT,
              evidence TEXT,
              next_action TEXT
            );
            """;
        await schema.ExecuteNonQueryAsync();
    }
    using var projectFixture = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(Directory.GetCurrentDirectory(), "native", "fixtures", "project-create-v1.json")));
    var projectFixtureRoot = projectFixture.RootElement;
    var requestFixture = projectFixtureRoot.GetProperty("nodeRequest");
    var defaultsFixture = projectFixtureRoot.GetProperty("nativeDefaults");
    var expectedFixture = projectFixtureRoot.GetProperty("expected");
    var createProject = new CreateProjectCommandHandler(new NativeDatabase(commandPath));
    var create = new CreateProjectCommand(
        requestFixture.GetProperty("name").GetString()!,
        defaultsFixture.GetProperty("status").GetString()!,
        defaultsFixture.GetProperty("owner").GetString()!,
        defaultsFixture.GetProperty("confidence").GetDouble(),
        defaultsFixture.GetProperty("evidence").GetString()!,
        requestFixture.GetProperty("next_action").GetString(),
        "project-fixture-1");
    var created = await createProject.ExecuteAsync(create, CancellationToken.None);
    var replayedProject = await createProject.ExecuteAsync(create, CancellationToken.None);
    if (created.Replayed || !replayedProject.Replayed || created.ProjectId != replayedProject.ProjectId)
        throw new InvalidOperationException("Native project command was not idempotent.");
    await using (var commandVerify = new SqliteConnection($"Data Source={commandPath};Pooling=False"))
    {
        await commandVerify.OpenAsync();
        await using var projectCount = commandVerify.CreateCommand();
        projectCount.CommandText = "SELECT COUNT(*) FROM projects";
        if (Convert.ToInt32(await projectCount.ExecuteScalarAsync()) != 1)
            throw new InvalidOperationException("Native project command duplicated an idempotent request.");
        await using var projectRow = commandVerify.CreateCommand();
        projectRow.CommandText = "SELECT name, status, owner, source, confidence, next_action FROM projects WHERE id = $id";
        projectRow.Parameters.AddWithValue("$id", created.ProjectId);
        await using var reader = await projectRow.ExecuteReaderAsync();
        if (!await reader.ReadAsync()
            || !StringComparer.Ordinal.Equals(reader.GetString(0), expectedFixture.GetProperty("name").GetString())
            || !StringComparer.Ordinal.Equals(reader.GetString(1), expectedFixture.GetProperty("status").GetString())
            || !StringComparer.Ordinal.Equals(reader.GetString(2), expectedFixture.GetProperty("owner").GetString())
            || !StringComparer.Ordinal.Equals(reader.GetString(3), expectedFixture.GetProperty("source").GetString())
            || Math.Abs(reader.GetDouble(4) - expectedFixture.GetProperty("confidence").GetDouble()) > 0.0001
            || !StringComparer.Ordinal.Equals(reader.GetString(5), expectedFixture.GetProperty("next_action").GetString()))
            throw new InvalidOperationException("Native project command did not reproduce the Node compatibility fixture.");
    }
    await AssertInvalidProjectAsync(createProject);
    Console.WriteLine("PASS native SQLite migration and transaction contract");
}

finally
{
    if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
}

static async Task AssertInvalidProjectAsync(CreateProjectCommandHandler handler)
{
    try
    {
        await handler.ExecuteAsync(new CreateProjectCommand("", "active", "user", 0.8, "fixture", null, "invalid-project"), CancellationToken.None);
        throw new InvalidOperationException("Native project command accepted an invalid request.");
    }
    catch (ArgumentException)
    {
    }
}
