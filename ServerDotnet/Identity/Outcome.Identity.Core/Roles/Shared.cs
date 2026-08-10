using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Roles;

public static class RoleMapper
{
    public static RoleDto ToDto(Role r) => new(r.Id, r.Name, r.Color, r.Permissions, r.Position, r.IsDefault);
}

internal static class RoleAuth
{
    public static void RequireManageRoles(long actorPermissions)
    {
        if (!Perms.Grants(Perms.FromBits(actorPermissions), Perms.ManageRoles))
            throw DomainException.Forbidden("insufficient permissions");
    }

    /// <summary>A non-admin cannot grant permission bits they do not themselves hold.</summary>
    public static void GuardEscalation(long actorPermissions, long targetPermissions)
    {
        if (!PermissionMath.HasAdmin(actorPermissions) && (targetPermissions & ~actorPermissions) != 0)
            throw DomainException.Forbidden("cannot grant permissions you do not have");
    }

    public static string ValidateName(string? name)
    {
        var n = (name ?? string.Empty).Trim();
        if (n.Length is 0 or > 32) throw DomainException.InvalidInput("name must be 1-32 characters");
        return n;
    }
}
