namespace Outcome.Domain.Entities;

/// <summary>A text/voice/announcement/dm channel.</summary>
public sealed class Channel
{
    public long Id { get; set; }
    /// <summary>Owning server (tenant), or null for cross-server channels like DMs.</summary>
    public long? ServerId { get; set; }
    public string Name { get; set; } = "";
    public string Type { get; set; } = "text";
    public string? Category { get; set; }
    public string? Topic { get; set; }
    public int Position { get; set; }
    public int SlowMode { get; set; }
    public bool Archived { get; set; }
    public bool Deleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public int VoiceMaxUsers { get; set; }
    public string? VoiceQuality { get; set; }
    public int? MixingThreshold { get; set; }
    public int VoiceMaxVideo { get; set; } = 25;
}

/// <summary>
/// Per-channel permission override for a role, as a claim row: one (permission, effect) pair per
/// row. <c>effect = "allow"</c> adds the permission for this channel, <c>"deny"</c> strips it.
/// This is the claim-based replacement for the old int64 allow/deny bitfields.
/// </summary>
public sealed class ChannelOverrideClaim
{
    public const string EffectAllow = "allow";
    public const string EffectDeny  = "deny";

    public long Id { get; set; }
    public long ChannelId { get; set; }
    public long RoleId { get; set; }
    public string Permission { get; set; } = "";
    public string Effect { get; set; } = "";
}

/// <summary>Per-user, per-channel read marker and mention counter.</summary>
public sealed class ReadState
{
    public long UserId { get; set; }
    public long ChannelId { get; set; }
    public long LastMessageId { get; set; }
    public int MentionCount { get; set; }
}

/// <summary>Live voice connection state for a user.</summary>
public sealed class VoiceState
{
    public long UserId { get; set; }
    public long ChannelId { get; set; }
    public bool Muted { get; set; }
    public bool Deafened { get; set; }
    public bool Speaking { get; set; }
    public DateTime JoinedAt { get; set; }
    public bool Camera { get; set; }
    public bool Screenshare { get; set; }
}
