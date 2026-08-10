using System.Security.Cryptography;
using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Invites;

// UseCount serializes as use_count to match the client's InviteResponse.use_count.
public sealed record InviteDto(long Id, string Code, int? MaxUses, int UseCount, DateTime? ExpiresAt, bool Revoked, DateTime CreatedAt);

public static class InviteMapper
{
    public static InviteDto ToDto(Invite i) => new(i.Id, i.Code, i.MaxUses, i.UseCount, i.ExpiresAt, i.Revoked, i.CreatedAt);
}

internal static class InviteAuth
{
    public static void Require(long perms)
    {
        if (!Perms.Grants(Perms.FromBits(perms), Perms.ManageInvites))
            throw DomainException.Forbidden("insufficient permissions");
    }
}
