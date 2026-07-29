using Microsoft.Data.Sqlite;
using LifePlanSystem.Native.Persistence;

namespace LifePlanSystem.Native.Contracts;

public sealed record CreateProjectCommand(
    string Name,
    string Status,
    string Owner,
    double Confidence,
    string Evidence,
    string? NextAction,
    string IdempotencyKey);

public sealed record ProjectCommandResult(long ProjectId, bool Replayed);

/// <summary>
/// First native write contract. It is intentionally not registered in the
/// compatibility host until request replay and ownership cutover are proven.
/// </summary>
public sealed class CreateProjectCommandHandler(NativeDatabase database)
{
    private static readonly HashSet<string> AllowedStatuses = new(StringComparer.Ordinal)
    {
        "active", "paused", "done", "completed", "archived"
    };

    private static readonly HashSet<string> AllowedOwners = new(StringComparer.Ordinal)
    {
        "user", "app"
    };

    public async Task<ProjectCommandResult> ExecuteAsync(CreateProjectCommand command, CancellationToken cancellationToken)
    {
        Validate(command);
        cancellationToken.ThrowIfCancellationRequested();
        return await database.InTransactionAsync(async (connection, transaction, token) =>
        {
            await EnsureReceiptsAsync(connection, transaction, token);
            var replayed = await ReadReceiptAsync(connection, transaction, command.IdempotencyKey, token);
            if (replayed is not null) return new ProjectCommandResult(replayed.Value, true);

            await using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO projects (name, status, owner, source, confidence, last_reviewed, evidence, next_action)
                VALUES ($name, $status, $owner, 'native-command', $confidence, date('now'), $evidence, $nextAction);
                SELECT last_insert_rowid();
                """;
            insert.Parameters.AddWithValue("$name", command.Name.Trim());
            insert.Parameters.AddWithValue("$status", command.Status);
            insert.Parameters.AddWithValue("$owner", command.Owner);
            insert.Parameters.AddWithValue("$confidence", command.Confidence);
            insert.Parameters.AddWithValue("$evidence", command.Evidence.Trim());
            insert.Parameters.AddWithValue("$nextAction", (object?)command.NextAction?.Trim() ?? DBNull.Value);
            var projectId = Convert.ToInt64(await insert.ExecuteScalarAsync(token));

            await using var receipt = connection.CreateCommand();
            receipt.Transaction = transaction;
            receipt.CommandText = "INSERT INTO native_command_receipts (idempotency_key, project_id) VALUES ($key, $projectId)";
            receipt.Parameters.AddWithValue("$key", command.IdempotencyKey);
            receipt.Parameters.AddWithValue("$projectId", projectId);
            await receipt.ExecuteNonQueryAsync(token);
            return new ProjectCommandResult(projectId, false);
        }, cancellationToken);
    }

    private static void Validate(CreateProjectCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (string.IsNullOrWhiteSpace(command.Name) || command.Name.Trim().Length > 200)
            throw new ArgumentException("Project name must contain 1 to 200 characters.", nameof(command));
        if (!AllowedStatuses.Contains(command.Status))
            throw new ArgumentException("Project status is not allowed.", nameof(command));
        if (!AllowedOwners.Contains(command.Owner))
            throw new ArgumentException("Project owner is not allowed.", nameof(command));
        if (double.IsNaN(command.Confidence) || double.IsInfinity(command.Confidence) || command.Confidence is < 0 or > 1)
            throw new ArgumentException("Project confidence must be between zero and one.", nameof(command));
        if (string.IsNullOrWhiteSpace(command.IdempotencyKey) || command.IdempotencyKey.Length > 128)
            throw new ArgumentException("Idempotency key is required and bounded.", nameof(command));
    }

    private static async Task EnsureReceiptsAsync(SqliteConnection connection, SqliteTransaction transaction, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS native_command_receipts (
              idempotency_key TEXT PRIMARY KEY,
              project_id INTEGER NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """;
        await command.ExecuteNonQueryAsync(token);
    }

    private static async Task<long?> ReadReceiptAsync(SqliteConnection connection, SqliteTransaction transaction, string key, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT project_id FROM native_command_receipts WHERE idempotency_key = $key";
        command.Parameters.AddWithValue("$key", key);
        var existing = await command.ExecuteScalarAsync(token);
        return existing is null ? null : Convert.ToInt64(existing);
    }
}
