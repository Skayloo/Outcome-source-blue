using System.Security.Cryptography;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Invites;

public sealed class CreateInviteHandler(IInviteRepository invites, ICurrentServer server) : IRequestHandler<CreateInviteCommand, InviteDto>
{
    public async Task<InviteDto> Handle(CreateInviteCommand cmd, CancellationToken ct)
    {
        InviteAuth.Require(cmd.ActorPermissions);
        var invite = new Invite
        {
            ServerId = server.ServerId,
            Code = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(5)),
            CreatedBy = cmd.ActorUserId,
            MaxUses = cmd.MaxUses > 0 ? cmd.MaxUses : null,
            ExpiresAt = cmd.ExpiresInHours > 0 ? DateTime.UtcNow.AddHours(cmd.ExpiresInHours) : null,
        };
        invite.Id = await invites.CreateAsync(invite, ct);
        return InviteMapper.ToDto(invite);
    }
}
