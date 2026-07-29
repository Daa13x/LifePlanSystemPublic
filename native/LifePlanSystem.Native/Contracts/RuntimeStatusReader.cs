using Microsoft.Data.Sqlite;

namespace LifePlanSystem.Native.Contracts;

public sealed record RuntimeStatus(
    bool DatabaseReady,
    int ActiveProjects,
    int BlockedItems,
    int ReviewItems,
    int MemoryCandidates);

public sealed class RuntimeStatusReader
{
    private readonly string _databasePath;

    public RuntimeStatusReader(string databasePath)
    {
        _databasePath = Path.GetFullPath(databasePath);
    }

    public async Task<RuntimeStatus> ReadAsync(CancellationToken cancellationToken)
    {
        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = _databasePath,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Private,
            ForeignKeys = true,
            Pooling = false,
            DefaultTimeout = 5
        }.ConnectionString;

        await using var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        return new RuntimeStatus(
            DatabaseReady: true,
            ActiveProjects: await CountAsync(connection, "SELECT COUNT(*) FROM projects WHERE status = 'active'", cancellationToken),
            BlockedItems: await CountAsync(connection, "SELECT COUNT(*) FROM knowledge_items WHERE type = 'blocker' AND status = 'active'", cancellationToken),
            ReviewItems: await CountAsync(connection, "SELECT COUNT(*) FROM knowledge_items WHERE status = 'review'", cancellationToken),
            MemoryCandidates: await CountAsync(connection, "SELECT COUNT(*) FROM memory_candidates", cancellationToken));
    }

    private static async Task<int> CountAsync(SqliteConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }
}
