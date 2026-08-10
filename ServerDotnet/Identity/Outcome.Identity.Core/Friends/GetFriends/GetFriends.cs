using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Friends;

// ── GET /api/v1/friends ──────────────────────────────────────────────────────
public sealed record GetFriendsQuery(long UserId) : IQuery<FriendsListDto>;
