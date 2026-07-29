using System.Text.Json;
using LifePlanSystem.Native.Security;

namespace LifePlanSystem.Native.Contracts;

/// <summary>Copied-profile-only adapter for the reviewed project update contract.</summary>
public sealed class NativeProjectUpdateCommandAdapter(UpdateProjectCommandHandler updateProject)
{
    private static readonly HashSet<string> RootFields = new(StringComparer.Ordinal) { "id", "previous", "updates" };
    private static readonly HashSet<string> SnapshotFields = new(StringComparer.Ordinal) { "name", "status", "owner", "confidence", "next_action", "shareability" };
    private static readonly HashSet<string> UpdateFields = new(SnapshotFields, StringComparer.Ordinal) { "evidence" };

    public Task<ProjectUpdateResult> ExecuteAsync(ValidatedNativeCommand command, CancellationToken cancellationToken)
    {
        if (!StringComparer.Ordinal.Equals(command.Type, "update-project")) throw new ArgumentException("Unsupported native command type.", nameof(command));
        var root = command.Payload;
        RequireObject(root, "payload", RootFields);
        if (!root.TryGetProperty("id", out var id) || !id.TryGetInt64(out var projectId) || projectId <= 0) throw new ArgumentException("Native update payload requires a positive numeric id.");
        if (!root.TryGetProperty("previous", out var previous)) throw new ArgumentException("Native update payload requires previous values.");
        if (!root.TryGetProperty("updates", out var updates)) throw new ArgumentException("Native update payload requires updates.");
        RequireObject(previous, "previous", SnapshotFields);
        RequireObject(updates, "updates", UpdateFields);
        return updateProject.ExecuteAsync(new UpdateProjectCommand(projectId, Snapshot(previous), Update(updates), command.CorrelationId.ToString("N")), cancellationToken);
    }

    private static ProjectSnapshot Snapshot(JsonElement value) => new(Text(value, "name"), Text(value, "status"), Text(value, "owner"), Number(value, "confidence"), Text(value, "next_action"), Text(value, "shareability"));
    private static ProjectUpdate Update(JsonElement value) => new(Text(value, "name"), Text(value, "status"), Text(value, "owner"), Number(value, "confidence"), Text(value, "evidence"), Text(value, "next_action"), Text(value, "shareability"));
    private static string? Text(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var field)) return null;
        if (field.ValueKind != JsonValueKind.String) throw new ArgumentException($"Native update field {name} must be text.");
        return field.GetString();
    }
    private static double? Number(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var field)) return null;
        if (field.ValueKind != JsonValueKind.Number || !field.TryGetDouble(out var number)) throw new ArgumentException($"Native update field {name} must be numeric.");
        return number;
    }
    private static void RequireObject(JsonElement value, string name, HashSet<string> allowed)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new ArgumentException($"Native update {name} must be an object.");
        foreach (var property in value.EnumerateObject()) if (!allowed.Contains(property.Name)) throw new ArgumentException($"Native update {name} contains unsupported field: {property.Name}.");
    }
}
