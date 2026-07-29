using LifePlanSystem.Native.Persistence;
using Microsoft.Data.Sqlite;

var root = Path.Combine(Path.GetTempPath(), "lps-native-db-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var path = Path.Combine(root, "copied-profile.sqlite");
try
{
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
    Console.WriteLine("PASS native SQLite migration and transaction contract");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
}
