using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;

namespace Outcome.Application.Auth;

public sealed class LogoutHandler(
    ICurrentUser current,
    ISessionRepository sessions,
    IAuditRepository audit) : IRequestHandler<LogoutCommand>
{
    public async Task Handle(LogoutCommand request, CancellationToken ct)
    {
        if (!current.IsAuthenticated || current.SessionTokenHash is null)
            throw DomainException.Unauthorized("not authenticated");

        await sessions.DeleteByTokenHashAsync(current.SessionTokenHash, ct);
        await audit.AddAsync(current.UserId, "user_logout", "user", current.UserId, string.Empty, ct);
    }
}
