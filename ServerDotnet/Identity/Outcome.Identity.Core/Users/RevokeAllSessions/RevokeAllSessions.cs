using MediatR;
using Outcome.Shared.Abstractions.Messaging;

namespace Outcome.Application.Users;

// ── DELETE /api/v1/users/me/sessions ─────────────────────────────────────────
// Revokes every login session EXCEPT the one making the call — the "sign out
// everywhere else" button. Keeping the current session means the user never
// saws off the branch they're sitting on.
public sealed record RevokeAllSessionsCommand(long UserId) : ICommand<RevokeAllSessionsResult>;

public sealed record RevokeAllSessionsResult(int Revoked);
