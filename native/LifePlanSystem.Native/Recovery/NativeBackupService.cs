using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace LifePlanSystem.Native.Recovery;

public sealed record NativeBackupEvidence(string BackupPath, string Sha256, DateTimeOffset CreatedAt);

public sealed class NativeBackupService
{
    public async Task<NativeBackupEvidence> CreateAndVerifyAsync(string sourcePath, string backupDirectory, CancellationToken cancellationToken)
    {
        sourcePath = Path.GetFullPath(sourcePath);
        backupDirectory = Path.GetFullPath(backupDirectory);
        if (!File.Exists(sourcePath)) throw new FileNotFoundException("SQLite source database is missing.", sourcePath);
        Directory.CreateDirectory(backupDirectory);
        var name = $"life-planner-{DateTimeOffset.UtcNow:yyyyMMddHHmmssfff}.sqlite";
        var backupPath = Path.Combine(backupDirectory, name);

        await using (var source = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = sourcePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false
        }.ConnectionString))
        await using (var target = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = backupPath, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false
        }.ConnectionString))
        {
            await source.OpenAsync(cancellationToken);
            await target.OpenAsync(cancellationToken);
            source.BackupDatabase(target);
        }

        await VerifySqliteAsync(backupPath, cancellationToken);
        await using var stream = File.OpenRead(backupPath);
        var hash = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken));
        return new NativeBackupEvidence(backupPath, hash, DateTimeOffset.UtcNow);
    }

    private static async Task VerifySqliteAsync(string path, CancellationToken cancellationToken)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false
        }.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA integrity_check";
        var integrity = Convert.ToString(await command.ExecuteScalarAsync(cancellationToken));
        if (!StringComparer.Ordinal.Equals(integrity, "ok"))
            throw new InvalidOperationException("SQLite backup integrity check did not return ok.");
    }
}
