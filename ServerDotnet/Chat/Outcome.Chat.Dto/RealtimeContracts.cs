namespace Outcome.Application.Realtime;

/// <summary>Attachment as delivered to clients (matches the web client's Attachment shape).</summary>
public sealed record AttachmentDto(string Id, string Filename, long Size, string Mime, string Url, int? Width, int? Height,
    [property: Newtonsoft.Json.JsonProperty("duration_ms", NullValueHandling = Newtonsoft.Json.NullValueHandling.Ignore)] int? DurationMs = null,
    [property: Newtonsoft.Json.JsonProperty("waveform", NullValueHandling = Newtonsoft.Json.NullValueHandling.Ignore)] string? Waveform = null);

/// <summary>Result of persisting a chat message. <see cref="DmParticipantIds"/> is non-null for DM
/// channels (so the caller fans out only to participants instead of broadcasting to all).</summary>
public sealed record CreatedMessage(
    long Id, DateTime Timestamp, string Content, string ChannelType, IReadOnlyList<long>? DmParticipantIds,
    IReadOnlyList<AttachmentDto> Attachments, string? ForwardedFrom = null, long? ServerId = null);
