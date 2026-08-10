namespace Outcome.Domain.Entities;

/// <summary>An audit log entry (canonical v6 shape).</summary>
public sealed class AuditLogEntry
{
    public long Id { get; set; }
    public long ActorId { get; set; }
    public string Action { get; set; } = "";
    public string TargetType { get; set; } = "";
    public long TargetId { get; set; }
    public string Detail { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

/// <summary>A key/value server setting.</summary>
public sealed class Setting
{
    public string Key { get; set; } = "";
    public string Value { get; set; } = "";
}
