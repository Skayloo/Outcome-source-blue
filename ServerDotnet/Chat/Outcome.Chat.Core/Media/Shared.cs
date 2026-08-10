using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Media;

internal static class MediaAuth
{
    public static void RequireManage(long permissions)
    {
        if (!Perms.Grants(Perms.FromBits(permissions), Perms.ManageServer))
            throw DomainException.Forbidden("insufficient permissions");
    }
}
