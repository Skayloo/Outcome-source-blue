using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Channels;

// ── GET /messages/{id}/readers — who read one's own line in a channel, in place of ✓✓ ──
public sealed record GetMessageReadersQuery(long MessageId) : IQuery<MessageReadersResponse>;

/// <summary>Everyone counted, the first <see cref="GetMessageReadersHandler.Limit"/> of them listed by name.</summary>
public sealed record MessageReadersResponse(long MessageId, int Count, IReadOnlyList<ReactorUserDto> Users);
