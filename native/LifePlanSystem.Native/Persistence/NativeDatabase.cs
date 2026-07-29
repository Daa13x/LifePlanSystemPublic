using Microsoft.Data.Sqlite;

namespace LifePlanSystem.Native.Persistence;

public sealed class NativeDatabase
{
    private readonly string _databasePath;

    public NativeDatabase(string databasePath)
    {
        _databasePath = Path.GetFullPath(databasePath);
    }

    public async Task MigrateAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_databasePath)!);
        await using var connection = Open();
        await connection.OpenAsync(cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            await ExecuteAsync(connection, transaction, """
                CREATE TABLE IF NOT EXISTS native_schema_migrations (
                  id TEXT PRIMARY KEY,
                  checksum TEXT NOT NULL,
                  application_build TEXT NOT NULL,
                  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """, cancellationToken);
            await ApplyMigrationAsync(connection, transaction, "native-contracts-v1",
                "8e6ce1e7a912fb032c5d7db3a62a43f3c84e8c0f388b2099bc27cdd9a7c7ed6a", cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public async Task<T> InTransactionAsync<T>(Func<SqliteConnection, SqliteTransaction, CancellationToken, Task<T>> action,
        CancellationToken cancellationToken)
    {
        await using var connection = Open();
        await connection.OpenAsync(cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
        try
        {
            var result = await action(connection, transaction, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return result;
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    private SqliteConnection Open()
    {
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = _databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
            ForeignKeys = true,
            DefaultTimeout = 5,
            Pooling = false
        };
        return new SqliteConnection(builder.ConnectionString);
    }

    private static async Task ApplyMigrationAsync(SqliteConnection connection, SqliteTransaction transaction,
        string id, string checksum, CancellationToken cancellationToken)
    {
        await using var query = connection.CreateCommand();
        query.Transaction = transaction;
        query.CommandText = "SELECT checksum FROM native_schema_migrations WHERE id = $id";
        query.Parameters.AddWithValue("$id", id);
        var existing = await query.ExecuteScalarAsync(cancellationToken) as string;
        if (existing is not null)
        {
            if (!StringComparer.Ordinal.Equals(existing, checksum))
                throw new InvalidOperationException($"Migration checksum mismatch for {id}.");
            return;
        }

        await using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
            INSERT INTO native_schema_migrations (id, checksum, application_build)
            VALUES ($id, $checksum, $build);
            """;
        insert.Parameters.AddWithValue("$id", id);
        insert.Parameters.AddWithValue("$checksum", checksum);
        insert.Parameters.AddWithValue("$build", Environment.GetEnvironmentVariable("LPS_BUILD_COMMIT") ?? "development");
        await insert.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task ExecuteAsync(SqliteConnection connection, SqliteTransaction transaction, string sql,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }
}
