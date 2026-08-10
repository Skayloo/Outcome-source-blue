using MediatR;
using Microsoft.AspNetCore.Identity;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;

namespace Outcome.Application.Users;

public sealed class RevokeSessionHandler(ISessionRepository sessions) : IRequestHandler<RevokeSessionCommand>
{
    public async Task Handle(RevokeSessionCommand cmd, CancellationToken ct)
    {
        if (!await sessions.DeleteByIdForUserAsync(cmd.SessionId, cmd.UserId, ct))
            throw DomainException.NotFound("session not found");
    }
}
