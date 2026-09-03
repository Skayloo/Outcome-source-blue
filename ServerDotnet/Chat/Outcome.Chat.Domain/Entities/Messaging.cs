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
    /// <summary>Who uploaded it. The id of an attachment is enough to attach it to a message,
    /// and the id travels in every signed URL the file was ever served from — so without an
    /// owner recorded here, anyone who was once shown a file could later post it as their own.
    /// Null on rows written before this column existed; those fall back to the old behaviour.</summary>
    public long? UploaderId { get; set; }
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

    /// <summary>Where this file sits among the ones sent with the same message, counted from
    /// zero. The sender's order is known ONLY at send time — it is the order of the ids in the
    /// message — and nothing else recovers it: the primary key is a random GUID, and upload
    /// time is a guess that holds right up until two files finish out of the order they were
    /// picked. Null on rows written before this column existed; those fall back to upload
    /// time, which is the best that can be said about them after the fact.</summary>
    public int? Position { get; set; }
}

/// <summary>An emoji reaction on a message by a user.</summary>
public sealed class Reaction
{
    public long Id { get; set; }
    public long MessageId { get; set; }
    public long UserId { get; set; }
    public string Emoji { get; set; } = "";
}
