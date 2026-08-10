using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Friends;

// ── DELETE /api/v1/friends/{userId} ──────────────────────────────────────────
public sealed record RemoveFriendCommand(long UserId, long OtherId) : ICommand<bool>;
