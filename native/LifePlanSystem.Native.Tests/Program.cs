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
              next_action TEXT,
              shareability TEXT NOT NULL DEFAULT 'unknown',
              updated_at TEXT
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

    var adapterValidator = new NativeCommandEnvelopeValidator();
    var adapterCapability = adapterValidator.IssueForTesting(localOrigin, "create-project", TimeSpan.FromMinutes(1));
    var adapterEnvelope = JsonSerializer.Serialize(new
    {
        version = 1,
        type = "create-project",
        correlationId = Guid.NewGuid(),
        expiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        capability = adapterCapability.Token,
        payload = new { name = "Adapter fixture", next_action = "Review from adapter." }
    });
    if (!adapterValidator.TryValidate(localOrigin.AbsoluteUri, adapterEnvelope, DateTimeOffset.UtcNow, out var adapterCommand) || adapterCommand is null)
        throw new InvalidOperationException("Native adapter fixture did not pass the envelope boundary.");
    var adapter = new NativeProjectCommandAdapter(createProject);
    var adapterCreated = await adapter.ExecuteAsync(adapterCommand, CancellationToken.None);
    var adapterReplayed = await adapter.ExecuteAsync(adapterCommand, CancellationToken.None);
    if (adapterCreated.Replayed || !adapterReplayed.Replayed || adapterCreated.ProjectId != adapterReplayed.ProjectId)
        throw new InvalidOperationException("Native adapter did not turn a validated correlation ID into an idempotent command.");
    using var rejectedPayload = JsonDocument.Parse("{\"name\":\"Rejected\",\"untrusted\":true}");
    try
    {
        await adapter.ExecuteAsync(new ValidatedNativeCommand("create-project", Guid.NewGuid(), rejectedPayload.RootElement.Clone()), CancellationToken.None);
        throw new InvalidOperationException("Native adapter accepted an unrecognised payload field.");
    }
    catch (ArgumentException)
    {
    }

    using var updateFixture = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(Directory.GetCurrentDirectory(), "native", "fixtures", "project-update-v1.json")));
    var updateFixtureRoot = updateFixture.RootElement;
    var previousFixture = updateFixtureRoot.GetProperty("previous");
    var updatesFixture = updateFixtureRoot.GetProperty("updates");
    await using (var seedUpdate = new SqliteConnection($"Data Source={commandPath};Pooling=False"))
    {
        await seedUpdate.OpenAsync();
        await using var insert = seedUpdate.CreateCommand();
        insert.CommandText = """
            INSERT INTO projects (id, name, status, owner, source, confidence, last_reviewed, evidence, next_action, shareability)
            VALUES (99, $name, $status, $owner, 'approved proposal', $confidence, date('now'), 'Before update', $nextAction, $shareability);
            """;
        insert.Parameters.AddWithValue("$name", previousFixture.GetProperty("name").GetString()!);
        insert.Parameters.AddWithValue("$status", previousFixture.GetProperty("status").GetString()!);
        insert.Parameters.AddWithValue("$owner", previousFixture.GetProperty("owner").GetString()!);
        insert.Parameters.AddWithValue("$confidence", previousFixture.GetProperty("confidence").GetDouble());
        insert.Parameters.AddWithValue("$nextAction", previousFixture.GetProperty("next_action").GetString()!);
        insert.Parameters.AddWithValue("$shareability", previousFixture.GetProperty("shareability").GetString()!);
        await insert.ExecuteNonQueryAsync();
    }
    var updateProject = new UpdateProjectCommandHandler(new NativeDatabase(commandPath));
    var projectUpdate = new UpdateProjectCommand(
        99,
        new ProjectSnapshot(
            previousFixture.GetProperty("name").GetString(), previousFixture.GetProperty("status").GetString(), previousFixture.GetProperty("owner").GetString(),
            previousFixture.GetProperty("confidence").GetDouble(), previousFixture.GetProperty("next_action").GetString(), previousFixture.GetProperty("shareability").GetString()),
        new ProjectUpdate(
            updatesFixture.GetProperty("name").GetString(), updatesFixture.GetProperty("status").GetString(), updatesFixture.GetProperty("owner").GetString(),
            updatesFixture.GetProperty("confidence").GetDouble(), updatesFixture.GetProperty("evidence").GetString(), updatesFixture.GetProperty("next_action").GetString(), updatesFixture.GetProperty("shareability").GetString()),
        "project-update-fixture-1");
    var updated = await updateProject.ExecuteAsync(projectUpdate, CancellationToken.None);
    var replayedUpdate = await updateProject.ExecuteAsync(projectUpdate, CancellationToken.None);
    if (updated.Replayed || !replayedUpdate.Replayed) throw new InvalidOperationException("Native project update was not idempotent.");
    await using (var verifyUpdate = new SqliteConnection($"Data Source={commandPath};Pooling=False"))
    {
        await verifyUpdate.OpenAsync();
        await using var row = verifyUpdate.CreateCommand();
        row.CommandText = "SELECT name, status, owner, confidence, evidence, next_action, shareability FROM projects WHERE id = 99";
        await using var reader = await row.ExecuteReaderAsync();
        if (!await reader.ReadAsync()
            || !StringComparer.Ordinal.Equals(reader.GetString(0), updatesFixture.GetProperty("name").GetString())
            || !StringComparer.Ordinal.Equals(reader.GetString(1), updatesFixture.GetProperty("status").GetString())
            || !StringComparer.Ordinal.Equals(reader.GetString(2), updatesFixture.GetProperty("owner").GetString())
            || Math.Abs(reader.GetDouble(3) - updatesFixture.GetProperty("confidence").GetDouble()) > 0.0001
            || !StringComparer.Ordinal.Equals(reader.GetString(4), updatesFixture.GetProperty("evidence").GetString())
            || !StringComparer.Ordinal.Equals(reader.GetString(5), updatesFixture.GetProperty("next_action").GetString())
            || !StringComparer.Ordinal.Equals(reader.GetString(6), updatesFixture.GetProperty("shareability").GetString()))
            throw new InvalidOperationException("Native project update did not reproduce the compatibility fixture.");
    }
    await AssertStaleProjectAsync(updateProject, projectUpdate);
    await AssertCancelledProjectAsync(createProject);
    await AssertMissingProjectAsync(updateProject, projectUpdate);
    await using (var seedAdapterUpdate = new SqliteConnection($"Data Source={commandPath};Pooling=False"))
    {
        await seedAdapterUpdate.OpenAsync();
        await using var insert = seedAdapterUpdate.CreateCommand();
        insert.CommandText = "INSERT INTO projects (id, name, status, owner, source, confidence, last_reviewed, evidence, next_action, shareability) VALUES (100, $name, $status, $owner, 'approved proposal', $confidence, date('now'), 'Before adapter update', $nextAction, $shareability)";
        insert.Parameters.AddWithValue("$name", previousFixture.GetProperty("name").GetString()!);
        insert.Parameters.AddWithValue("$status", previousFixture.GetProperty("status").GetString()!);
        insert.Parameters.AddWithValue("$owner", previousFixture.GetProperty("owner").GetString()!);
        insert.Parameters.AddWithValue("$confidence", previousFixture.GetProperty("confidence").GetDouble());
        insert.Parameters.AddWithValue("$nextAction", previousFixture.GetProperty("next_action").GetString()!);
        insert.Parameters.AddWithValue("$shareability", previousFixture.GetProperty("shareability").GetString()!);
        await insert.ExecuteNonQueryAsync();
    }
    var updateAdapterValidator = new NativeCommandEnvelopeValidator();
    var updateAdapterCapability = updateAdapterValidator.IssueForTesting(localOrigin, "update-project", TimeSpan.FromMinutes(1));
    var updateAdapterEnvelope = JsonSerializer.Serialize(new
    {
        version = 1, type = "update-project", correlationId = Guid.NewGuid(), expiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        capability = updateAdapterCapability.Token, payload = new { id = 100, previous = previousFixture, updates = updatesFixture }
    });
    if (!updateAdapterValidator.TryValidate(localOrigin.AbsoluteUri, updateAdapterEnvelope, DateTimeOffset.UtcNow, out var validatedUpdate) || validatedUpdate is null)
        throw new InvalidOperationException("Native update adapter fixture did not pass the envelope boundary.");
    var updateAdapter = new NativeProjectUpdateCommandAdapter(updateProject);
    var adapterUpdate = await updateAdapter.ExecuteAsync(validatedUpdate, CancellationToken.None);
    var replayedAdapterUpdate = await updateAdapter.ExecuteAsync(validatedUpdate, CancellationToken.None);
    if (adapterUpdate.Replayed || !replayedAdapterUpdate.Replayed) throw new InvalidOperationException("Native update adapter did not provide idempotent replay.");
    using var malformedUpdatePayload = JsonDocument.Parse("{\"id\":100,\"previous\":{},\"updates\":{\"untrusted\":true}}");
    try
    {
        await updateAdapter.ExecuteAsync(new ValidatedNativeCommand("update-project", Guid.NewGuid(), malformedUpdatePayload.RootElement.Clone()), CancellationToken.None);
        throw new InvalidOperationException("Native update adapter accepted an unrecognised field.");
    }
    catch (ArgumentException)
    {
    }
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

static async Task AssertStaleProjectAsync(UpdateProjectCommandHandler handler, UpdateProjectCommand command)
{
    try
    {
        await handler.ExecuteAsync(command with { IdempotencyKey = "project-update-stale-1", Expected = command.Expected with { Name = "stale" } }, CancellationToken.None);
        throw new InvalidOperationException("Native project update accepted stale expected values.");
    }
    catch (ProjectStaleException)
    {
    }
}

static async Task AssertCancelledProjectAsync(CreateProjectCommandHandler handler)
{
    using var cancellation = new CancellationTokenSource();
    cancellation.Cancel();
    try
    {
        await handler.ExecuteAsync(new CreateProjectCommand("Cancelled", "active", "user", 0.5, "fixture", null, "cancelled-project"), cancellation.Token);
        throw new InvalidOperationException("Native project command ignored cancellation.");
    }
    catch (OperationCanceledException)
    {
    }
}

static async Task AssertMissingProjectAsync(UpdateProjectCommandHandler handler, UpdateProjectCommand command)
{
    try
    {
        await handler.ExecuteAsync(command with { ProjectId = 999, IdempotencyKey = "missing-project-update" }, CancellationToken.None);
        throw new InvalidOperationException("Native project update accepted a missing project.");
    }
    catch (KeyNotFoundException)
    {
    }
}
