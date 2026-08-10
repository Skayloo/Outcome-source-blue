using System.Security.Cryptography;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Invites;

public sealed class RevokeInviteHandler(IInviteRepository invites) : IRequestHandler<RevokeInviteCommand>
{
    public async Task Handle(RevokeInviteCommand cmd, CancellationToken ct)
    {
        InviteAuth.Require(cmd.ActorPermissions);
        if (!await invites.RevokeAsync(cmd.ServerId, cmd.Code, ct))
            throw DomainException.NotFound("invite not found");
    }
}
