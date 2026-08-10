using System.Security.Cryptography;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

using Outcome.Application.Common;

namespace Outcome.Application.Invites;

public sealed class ListInvitesHandler(IInviteRepository invites) : IRequestHandler<ListInvitesQuery, Paged<InviteDto>>
{
    public async Task<Paged<InviteDto>> Handle(ListInvitesQuery q, CancellationToken ct)
    {
        InviteAuth.Require(q.ActorPermissions);
        var page = (await invites.ListAsync(q.ServerId, Math.Clamp(q.Limit, 1, int.MaxValue), Math.Max(0, q.Offset), ct))
            .Select(InviteMapper.ToDto).ToList();
        return new(page, await invites.CountAsync(q.ServerId, ct));
    }
}
