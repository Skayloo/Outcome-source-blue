namespace Outcome.Domain.Entities;

/// <summary>A channel message. Soft-deleted via <see cref="Deleted"/>.</summary>
public sealed class Message
{
    public long Id { get; set; }
    public long ChannelId { get; set; }
    public long UserId { get; set; }
    public string Content { get; set; } = "";
    public long? ReplyTo { get; set; }
    public DateTime? EditedAt { get; set; }
    public bool Deleted { get; set; }
    public bool Pinned { get; set; }
    public DateTime Timestamp { get; set; }
    /// <summary>Display name of the ORIGINAL author when this message was forwarded. A label,
    /// not a reference: the source may be an E2EE DM the server can't see into.</summary>
    public string? ForwardedFrom { get; set; }
}

/// <summary>An uploaded file linked (optionally) to a message. <see cref="Id"/> is a UUID string.</summary>
public sealed class Attachment
{
    public string Id { get; set; } = "";
    public long? MessageId { get; set; }
    public string Filename { get; set; } = "";
    public string StoredAs { get; set; } = "";
    public string MimeType { get; set; } = "";
    public long Size { get; set; }
    public DateTime UploadedAt { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
    /// <summary>Voice message duration in ms (set by the transcoder). Null for non-audio.</summary>
    public int? DurationMs { get; set; }
    /// <summary>JSON array of ~0-100 amplitude peaks for the waveform bars. Null for non-audio.</summary>
    public string? Waveform { get; set; }
}

/// <summary>An emoji reaction on a message by a user.</summary>
public sealed class Reaction
{
    public long Id { get; set; }
    public long MessageId { get; set; }
    public long UserId { get; set; }
    public string Emoji { get; set; } = "";
}
