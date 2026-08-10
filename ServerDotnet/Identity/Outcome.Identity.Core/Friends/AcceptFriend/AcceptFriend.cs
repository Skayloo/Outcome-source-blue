using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Friends;

// ── POST /api/v1/friends/{userId}/accept ─────────────────────────────────────
public sealed record AcceptFriendCommand(long UserId, long OtherId) : ICommand<bool>;
