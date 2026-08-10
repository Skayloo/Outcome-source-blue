namespace Outcome.Application.Friends;

/// <summary>A friendship as seen by one side: <see cref="Id"/> is the OTHER user's id.</summary>
public sealed record FriendDto(long Id, string Username, string? Avatar, string Status);

/// <summary>The requester's full friends view: accepted friends plus pending requests in both directions.</summary>
public sealed record FriendsListDto(
    IReadOnlyList<FriendDto> Friends,
    IReadOnlyList<FriendDto> Incoming,
    IReadOnlyList<FriendDto> Outgoing);
