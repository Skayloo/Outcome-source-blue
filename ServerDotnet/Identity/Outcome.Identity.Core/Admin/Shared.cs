using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Admin;

internal static class AdminAuth
{
    public static void Require(long permissions, string needed)
    {
        if (!Perms.Grants(Perms.FromBits(permissions), needed))
            throw DomainException.Forbidden("insufficient permissions");
    }
}
