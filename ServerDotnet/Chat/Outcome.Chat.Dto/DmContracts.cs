namespace Outcome.Application.Dm;

public sealed record DmUserDto(long Id, string Username, string Avatar, string Status, string? PublicKey);

public sealed record DmChannelInfoDto(
    long ChannelId, DmUserDto Recipient, long? LastMessageId, string LastMessage, string LastMessageAt, int UnreadCount,
    long PeerReadUpTo = 0);

public sealed record DmListResponse(IReadOnlyList<DmChannelInfoDto> DmChannels);

public sealed record CreateDmResult(long ChannelId, DmUserDto Recipient, bool Created);
