namespace Outcome.Application.Realtime;

/// <summary>Member summary included in the WS ready snapshot and member events.</summary>
/// <param name="CreatedAt">When the account was made — the "member since" line on a profile.</param>
public sealed record MemberDto(long Id, string Username, string? Avatar, string Status, long RoleId,
    DateTimeOffset CreatedAt);
