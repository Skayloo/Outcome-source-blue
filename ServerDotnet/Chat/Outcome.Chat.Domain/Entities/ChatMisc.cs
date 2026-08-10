namespace Outcome.Domain.Entities;

/// <summary>A custom server emoji.</summary>
public sealed class Emoji
{
    public long Id { get; set; }
    public string Shortcode { get; set; } = "";
    public string Filename { get; set; } = "";
    public long UploadedBy { get; set; }
    public DateTime CreatedAt { get; set; }
}

/// <summary>A soundboard sound.</summary>
public sealed class Sound
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string Filename { get; set; } = "";
    public int DurationMs { get; set; }
    public long UploadedBy { get; set; }
    public DateTime CreatedAt { get; set; }
}

/// <summary>Membership of a user in a DM channel.</summary>
public sealed class DmParticipant
{
    public long ChannelId { get; set; }
    public long UserId { get; set; }
}

/// <summary>Tracks which DM channels a user currently has open in the sidebar.</summary>
public sealed class DmOpenState
{
    public long UserId { get; set; }
    public long ChannelId { get; set; }
    public DateTime OpenedAt { get; set; }
}

/// <summary>Per-user "I have played this voice message" marker (Telegram's listened state).</summary>
public sealed class VoiceListen
{
    public long UserId { get; set; }
    public string AttachmentId { get; set; } = "";
    public DateTime ListenedAt { get; set; }
}

/// <summary>Per-user "don't notify me about this chat" flag — any channel type, DMs included.</summary>
public sealed class ChannelMute
{
    public long UserId { get; set; }
    public long ChannelId { get; set; }
    public DateTime CreatedAt { get; set; }
}
