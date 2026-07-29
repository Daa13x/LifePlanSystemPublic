using System.Text.Json;
using LifePlanSystem.Native.Security;

namespace LifePlanSystem.Native.Contracts;

/// <summary>
/// Copied-profile adapter for the first native command. It deliberately accepts
/// only an already validated envelope and is not registered with the WebView,
/// loopback host, or installed profile. A correlation ID is the durable retry
/// key so a newly issued one-use capability can safely retry the same command.
/// </summary>
public sealed class NativeProjectCommandAdapter(CreateProjectCommandHandler createProject)
{
    private static readonly HashSet<string> CreateProjectFields = new(StringComparer.Ordinal)
    {
        "name", "status", "owner", "confidence", "evidence", "next_action"
    };

    public Task<ProjectCommandResult> ExecuteAsync(ValidatedNativeCommand command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!StringComparer.Ordinal.Equals(command.Type, "create-project"))
            throw new ArgumentException("Unsupported native command type.", nameof(command));

        var payload = command.Payload;
        if (payload.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("Native command payload must be an object.", nameof(command));
        foreach (var property in payload.EnumerateObject())
        {
            if (!CreateProjectFields.Contains(property.Name))
                throw new ArgumentException($"Native create-project payload contains an unsupported field: {property.Name}.", nameof(command));
        }

        return createProject.ExecuteAsync(new CreateProjectCommand(
            RequiredString(payload, "name"),
            OptionalString(payload, "status") ?? "active",
            OptionalString(payload, "owner") ?? "user",
            OptionalDouble(payload, "confidence") ?? 0.75,
            OptionalString(payload, "evidence") ?? "Manual entry",
            OptionalString(payload, "next_action") ?? string.Empty,
            command.CorrelationId.ToString("N")), cancellationToken);
    }

    private static string RequiredString(JsonElement payload, string name)
        => OptionalString(payload, name) ?? throw new ArgumentException($"Native create-project payload requires {name}.");

    private static string? OptionalString(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var value)) return null;
        if (value.ValueKind != JsonValueKind.String) throw new ArgumentException($"Native create-project field {name} must be text.");
        return value.GetString();
    }

    private static double? OptionalDouble(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var value)) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var result))
            throw new ArgumentException($"Native create-project field {name} must be a number.");
        return result;
    }
}
