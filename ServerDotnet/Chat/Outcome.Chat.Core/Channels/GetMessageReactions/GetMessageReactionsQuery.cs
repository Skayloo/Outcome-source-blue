using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Channels;

// ── GET /messages/{id}/reactions — who reacted, for the hover card and the full list ──
public sealed record GetMessageReactionsQuery(long MessageId) : IQuery<MessageReactionsResponse>;

public sealed record MessageReactionsResponse(long MessageId, IReadOnlyList<ReactionGroupDto> Reactions);

/// <summary>One emoji and the people who put it, newest first (as Telegram lists them).</summary>
public sealed record ReactionGroupDto(string Emoji, int Count, IReadOnlyList<ReactorUserDto> Users);

public sealed record ReactorUserDto(long Id, string Username, string? Avatar);
