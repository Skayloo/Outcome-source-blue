using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Friends;

// ── POST /api/v1/friends ─────────────────────────────────────────────────────
public sealed record SendFriendRequestCommand(long FromUserId, long ToUserId) : ICommand<SendFriendRequestResult>;

/// <summary><see cref="Created"/> = a new pending request was inserted; <see cref="AutoAccepted"/> =
/// the target had already requested this user, so the two are now friends.</summary>
public sealed record SendFriendRequestResult(bool Created, bool AutoAccepted);
