using LifePlanSystem.Native.Persistence;
using Microsoft.Data.Sqlite;

namespace LifePlanSystem.Native.Providers;

public sealed record ProviderRequest(string IdempotencyKey, string Provider, string Model, string PromptHash, string State);
public sealed class ProviderRequestJournal(NativeDatabase database)
{
    public Task<ProviderRequest> BeginAsync(ProviderRequest request, CancellationToken token) => database.InTransactionAsync(async (c, t, ct) =>
    {
        await using var schema = c.CreateCommand(); schema.Transaction=t; schema.CommandText="CREATE TABLE IF NOT EXISTS native_provider_requests (idempotency_key TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_hash TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"; await schema.ExecuteNonQueryAsync(ct);
        await using var read=c.CreateCommand(); read.Transaction=t; read.CommandText="SELECT provider, model, prompt_hash, state FROM native_provider_requests WHERE idempotency_key=$key"; read.Parameters.AddWithValue("$key",request.IdempotencyKey); await using var r=await read.ExecuteReaderAsync(ct);
        if(await r.ReadAsync(ct)) return new ProviderRequest(request.IdempotencyKey,r.GetString(0),r.GetString(1),r.GetString(2),r.GetString(3));
        await using var insert=c.CreateCommand(); insert.Transaction=t; insert.CommandText="INSERT INTO native_provider_requests (idempotency_key,provider,model,prompt_hash,state) VALUES ($key,$provider,$model,$hash,$state)"; insert.Parameters.AddWithValue("$key",request.IdempotencyKey); insert.Parameters.AddWithValue("$provider",request.Provider); insert.Parameters.AddWithValue("$model",request.Model); insert.Parameters.AddWithValue("$hash",request.PromptHash); insert.Parameters.AddWithValue("$state",request.State); await insert.ExecuteNonQueryAsync(ct); return request;
    },token);
}
