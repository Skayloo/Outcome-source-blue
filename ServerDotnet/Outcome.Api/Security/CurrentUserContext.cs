using Outcome.Shared.Abstractions.Security;
using P = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Api.Security;

/// <summary>Request-scoped holder for the authenticated principal, populated by auth middleware.</summary>
public sealed class CurrentUserContext : ICurrentUser
{
    public bool IsAuthenticated { get; private set; }
    public long UserId { get; private set; }
    public long RoleId { get; private set; }
    public long Permissions { get; private set; }
    public IReadOnlyCollection<string> PermissionNames { get; private set; } = [];
    public string? SessionTokenHash { get; private set; }

    public void Set(long userId, long roleId, long permissions, IReadOnlyCollection<string> permissionNames, string sessionTokenHash)
    {
        IsAuthenticated = true;
        UserId = userId;
        RoleId = roleId;
        Permissions = permissions;
        PermissionNames = permissionNames;
        SessionTokenHash = sessionTokenHash;
    }

    /// <summary>Grants the SERVER-scoped permissions of the ACTIVE server's owner for the rest of
    /// this request — see <see cref="Outcome.Domain.Permissions.Permission.ServerOwnerGrant"/> for
    /// what is in that set and why it is as small as it is. No global Administrator bypass, and
    /// nothing an instance-wide handler will accept. Idempotent.</summary>
    public void GrantServerAdmin()
    {
        const long bits = Outcome.Domain.Permissions.Permission.ServerOwnerGrant;
        if ((Permissions & bits) == bits) return;
        Permissions |= bits;
        // The bitfield and the name list are read by different call sites (PermCheck reads names),
        // so they have to move together or a permission holds in one check and not the other.
        var names = new List<string>(PermissionNames);
        foreach (var n in new[] { P.ManageChannels, P.ManageInvites, P.ManageMessages })
            if (!names.Contains(n)) names.Add(n);
        PermissionNames = names;
    }
}
