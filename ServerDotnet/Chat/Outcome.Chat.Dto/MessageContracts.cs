using Newtonsoft.Json;

namespace Outcome.Application.Channels;

public sealed record UserPublicDto(
    long Id,
    string Username,
    [property: JsonProperty(NullValueHandling = NullValueHandling.Ignore)] string? Avatar);

public sealed record AttachmentInfoDto(
    string Id,
    string Filename,
    long Size,
    string Mime,
    string Url,
    [property: JsonProperty(NullValueHandling = NullValueHandling.Ignore)] int? Width,
    [property: JsonProperty(NullValueHandling = NullValueHandling.Ignore)] int? Height,
    [property: JsonProperty("duration_ms", NullValueHandling = NullValueHandling.Ignore)] int? DurationMs = null,
    [property: JsonProperty("waveform", NullValueHandling = NullValueHandling.Ignore)] string? Waveform = null,
    bool Listened = false,
    [property: JsonProperty("listened_by_others")] bool ListenedByOthers = false);

public sealed record ReactionInfoDto(string Emoji, int Count, bool Me);

/// <summary>Message wire shape for GET /channels/{id}/messages (matches Go MessageAPIResponse).</summary>
// Listened: whether the REQUESTING user has played this voice attachment (per-user, REST only).
public sealed record MessageDto(
    long Id,
    long ChannelId,
    UserPublicDto User,
    string Content,
    long? ReplyTo,
    IReadOnlyList<AttachmentInfoDto> Attachments,
    IReadOnlyList<ReactionInfoDto> Reactions,
    bool Pinned,
    DateTime? EditedAt,
    bool Deleted,
    DateTime Timestamp,
    string? ForwardedFrom = null,
    [property: JsonProperty("guest_name", NullValueHandling = NullValueHandling.Ignore)] string? GuestName = null);

public sealed record ChannelMessagesResponse(IReadOnlyList<MessageDto> Messages, bool HasMore);

/// <summary>One line of a voice room's chat as a guest sees it: who wrote it (a member's name, or
/// a guest's own), whether that was a guest, and the text. No attachments, no reactions.</summary>
public sealed record GuestChatRow(long Id, string Author, bool Guest, string? Avatar, string Content, DateTime Timestamp);
