namespace Outcome.Application.Search;

/// <summary>Raw search row (includes channel type for the permission/DM filter).
/// Returned by <c>IMessageRepository.SearchAsync</c>.</summary>
public sealed record SearchRow(
    long MessageId, long ChannelId, string ChannelName, string ChannelType,
    long UserId, string Username, string? Avatar, string Content, DateTime Timestamp);
