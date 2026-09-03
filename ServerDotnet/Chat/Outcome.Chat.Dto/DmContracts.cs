namespace Outcome.Application.Dm;

public sealed record DmUserDto(long Id, string Username, string Avatar, string Status);

/// <param name="LastAttachmentMime">Mime type of the first file on the last message, null when it
/// carried none. A message that is nothing but a photo has an EMPTY <paramref name="LastMessage"/>,
/// and a sidebar row with no preview line reads as an empty conversation — which is what this is
/// for. The server sends the mime rather than a caption because the caption is a translated
/// string, and the server does not know the reader's language; both clients already classify
/// attachments by mime and duration, and this feeds the same rule.</param>
/// <param name="LastAttachmentDurationMs">Duration of that file when it is audio — the half of the
/// rule that separates a voice message from any other sound file.</param>
public sealed record DmChannelInfoDto(
    long ChannelId, DmUserDto Recipient, long? LastMessageId, string LastMessage, string LastMessageAt, int UnreadCount,
    long PeerReadUpTo = 0, string? LastAttachmentMime = null, int? LastAttachmentDurationMs = null);

public sealed record DmListResponse(IReadOnlyList<DmChannelInfoDto> DmChannels);

public sealed record CreateDmResult(long ChannelId, DmUserDto Recipient, bool Created);
