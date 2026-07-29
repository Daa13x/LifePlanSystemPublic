using Microsoft.Data.Sqlite;
using LifePlanSystem.Native.Persistence;

namespace LifePlanSystem.Native.Contracts;

public sealed record ProjectSnapshot(string? Name, string? Status, string? Owner, double? Confidence, string? NextAction, string? Shareability);
public sealed record ProjectUpdate(string? Name, string? Status, string? Owner, double? Confidence, string? Evidence, string? NextAction, string? Shareability);
public sealed record UpdateProjectCommand(long ProjectId, ProjectSnapshot Expected, ProjectUpdate Updates, string IdempotencyKey);
public sealed record ProjectUpdateResult(bool Replayed);
public sealed class ProjectStaleException : InvalidOperationException
{
    public ProjectStaleException() : base("Project changed after the proposal was created.") { }
}

/// <summary>
/// Copied-profile-only parity contract for the existing approval update path.
/// It is not registered with the compatibility host or a live write route.
/// </summary>
public sealed class UpdateProjectCommandHandler(NativeDatabase database)
{
    private static readonly HashSet<string> AllowedStatuses = new(StringComparer.Ordinal)
    {
        "active", "blocked", "waiting", "stable", "archived", "done", "completed"
    };
    private static readonly HashSet<string> AllowedShareability = new(StringComparer.Ordinal)
    {
        "unknown", "private", "local-shareable", "public-shareable"
    };

    public async Task<ProjectUpdateResult> ExecuteAsync(UpdateProjectCommand command, CancellationToken cancellationToken)
    {
        Validate(command);
        cancellationToken.ThrowIfCancellationRequested();
        return await database.InTransactionAsync(async (connection, transaction, token) =>
        {
            await EnsureReceiptsAsync(connection, transaction, token);
            if (await ReceiptExistsAsync(connection, transaction, command.IdempotencyKey, token)) return new ProjectUpdateResult(true);
            var current = await ReadCurrentAsync(connection, transaction, command.ProjectId, token)
                ?? throw new KeyNotFoundException("Project was not found.");
            if (!MatchesExpected(current, command.Expected)) throw new ProjectStaleException();

            await using var update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = """
                UPDATE projects
                SET name = COALESCE($name, name),
                    status = COALESCE($status, status),
                    owner = COALESCE($owner, owner),
                    confidence = COALESCE($confidence, confidence),
                    last_reviewed = date('now'),
                    evidence = COALESCE($evidence, evidence),
                    next_action = COALESCE($nextAction, next_action),
                    shareability = COALESCE($shareability, shareability),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $id;
                """;
            update.Parameters.AddWithValue("$name", (object?)command.Updates.Name?.Trim() ?? DBNull.Value);
            update.Parameters.AddWithValue("$status", (object?)command.Updates.Status ?? DBNull.Value);
            update.Parameters.AddWithValue("$owner", (object?)command.Updates.Owner?.Trim() ?? DBNull.Value);
            update.Parameters.AddWithValue("$confidence", (object?)command.Updates.Confidence ?? DBNull.Value);
            update.Parameters.AddWithValue("$evidence", (object?)command.Updates.Evidence?.Trim() ?? DBNull.Value);
            update.Parameters.AddWithValue("$nextAction", (object?)command.Updates.NextAction?.Trim() ?? DBNull.Value);
            update.Parameters.AddWithValue("$shareability", (object?)command.Updates.Shareability ?? DBNull.Value);
            update.Parameters.AddWithValue("$id", command.ProjectId);
            if (await update.ExecuteNonQueryAsync(token) != 1) throw new KeyNotFoundException("Project was not found.");

            await using var receipt = connection.CreateCommand();
            receipt.Transaction = transaction;
            receipt.CommandText = "INSERT INTO native_project_update_receipts (idempotency_key, project_id) VALUES ($key, $projectId)";
            receipt.Parameters.AddWithValue("$key", command.IdempotencyKey);
            receipt.Parameters.AddWithValue("$projectId", command.ProjectId);
            await receipt.ExecuteNonQueryAsync(token);
            return new ProjectUpdateResult(false);
        }, cancellationToken);
    }

    private static void Validate(UpdateProjectCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.ProjectId <= 0 || string.IsNullOrWhiteSpace(command.IdempotencyKey) || command.IdempotencyKey.Length > 128)
            throw new ArgumentException("Project id and bounded idempotency key are required.", nameof(command));
        var update = command.Updates ?? throw new ArgumentException("Project updates are required.", nameof(command));
        if (update.Name is not null && (string.IsNullOrWhiteSpace(update.Name) || update.Name.Trim().Length > 200))
            throw new ArgumentException("Project name must contain 1 to 200 characters.", nameof(command));
        if (update.Status is not null && !AllowedStatuses.Contains(update.Status))
            throw new ArgumentException("Project status is not allowed.", nameof(command));
        if (update.Owner is not null && (string.IsNullOrWhiteSpace(update.Owner) || update.Owner.Trim().Length > 120))
            throw new ArgumentException("Project owner must contain 1 to 120 characters.", nameof(command));
        if (update.Confidence is not null && (double.IsNaN(update.Confidence.Value) || double.IsInfinity(update.Confidence.Value) || update.Confidence is < 0 or > 1))
            throw new ArgumentException("Project confidence must be between zero and one.", nameof(command));
        if (update.Shareability is not null && !AllowedShareability.Contains(update.Shareability))
            throw new ArgumentException("Project shareability is not allowed.", nameof(command));
        if (update.Evidence?.Length > 4000 || update.NextAction?.Length > 4000)
            throw new ArgumentException("Project evidence and next action are bounded to 4000 characters.", nameof(command));
    }

    private static async Task EnsureReceiptsAsync(SqliteConnection connection, SqliteTransaction transaction, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS native_project_update_receipts (
              idempotency_key TEXT PRIMARY KEY,
              project_id INTEGER NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """;
        await command.ExecuteNonQueryAsync(token);
    }

    private static async Task<bool> ReceiptExistsAsync(SqliteConnection connection, SqliteTransaction transaction, string key, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT 1 FROM native_project_update_receipts WHERE idempotency_key = $key";
        command.Parameters.AddWithValue("$key", key);
        return await command.ExecuteScalarAsync(token) is not null;
    }

    private static async Task<ProjectSnapshot?> ReadCurrentAsync(SqliteConnection connection, SqliteTransaction transaction, long id, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT name, status, owner, confidence, next_action, shareability FROM projects WHERE id = $id";
        command.Parameters.AddWithValue("$id", id);
        await using var reader = await command.ExecuteReaderAsync(token);
        return await reader.ReadAsync(token)
            ? new ProjectSnapshot(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetDouble(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.IsDBNull(5) ? null : reader.GetString(5))
            : null;
    }

    private static bool MatchesExpected(ProjectSnapshot current, ProjectSnapshot expected) =>
        (expected.Name is null || StringComparer.Ordinal.Equals(current.Name, expected.Name))
        && (expected.Status is null || StringComparer.Ordinal.Equals(current.Status, expected.Status))
        && (expected.Owner is null || StringComparer.Ordinal.Equals(current.Owner, expected.Owner))
        && (expected.Confidence is null || current.Confidence == expected.Confidence)
        && (expected.NextAction is null || StringComparer.Ordinal.Equals(current.NextAction, expected.NextAction))
        && (expected.Shareability is null || StringComparer.Ordinal.Equals(current.Shareability, expected.Shareability));
}
