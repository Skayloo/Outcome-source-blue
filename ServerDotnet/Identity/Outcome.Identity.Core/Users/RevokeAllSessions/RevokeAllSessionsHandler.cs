using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

public sealed class RevokeAllSessionsHandler(
    ICurrentUser current,
    ISessionRepository sessions,
    IAuditRepository audit) : IRequestHandler<RevokeAllSessionsCommand, RevokeAllSessionsResult>
{
    public async Task<RevokeAllSessionsResult> Handle(RevokeAllSessionsCommand cmd, CancellationToken ct)
    {
        // The current session is identified by its token hash (same mechanism as logout);
        // without it we cannot know which session to spare.
        if (current.SessionTokenHash is null)
            throw DomainException.Unauthorized("not authenticated");

        var revoked = await sessions.DeleteAllForUserExceptAsync(cmd.UserId, current.SessionTokenHash, ct);
        await audit.AddAsync(cmd.UserId, "sessions_revoke_all", "user", cmd.UserId, $"revoked {revoked} sessions", ct);
        return new RevokeAllSessionsResult(revoked);
    }
}
