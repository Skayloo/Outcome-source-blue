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

    /// <summary>Grants SERVER-scoped admin permissions (manage channels/invites/messages + kick) for
    /// the rest of this request — makes the owner of their ACTIVE server an admin WITHIN it, WITHOUT
    /// the global Administrator bypass. So a per-server owner can run their own server but cannot edit
    /// global roles, change instance settings, ban users, or touch other tenants. Idempotent.</summary>
    public void GrantServerAdmin()
    {
        const long bits = Outcome.Domain.Permissions.Permission.ManageChannels
                        | Outcome.Domain.Permissions.Permission.ManageInvites
                        | Outcome.Domain.Permissions.Permission.ManageMessages
                        | Outcome.Domain.Permissions.Permission.KickMembers
                        | Outcome.Domain.Permissions.Permission.MuteMembers
                        | Outcome.Domain.Permissions.Permission.ManageRoles
                        | Outcome.Domain.Permissions.Permission.ManageServer
                        | Outcome.Domain.Permissions.Permission.ViewAuditLog;
        if ((Permissions & bits) == bits) return;
        Permissions |= bits;
        var names = new List<string>(PermissionNames);
        void AddName(string n) { if (!names.Contains(n)) names.Add(n); }
        AddName(P.ManageChannels);
        AddName(P.ManageInvites);
        AddName(P.ManageMessages);
        AddName(P.KickMembers);
        AddName(P.MuteMembers);
        AddName(P.ManageRoles);
        AddName(P.ManageServer);
        AddName(P.ViewAuditLog);
        PermissionNames = names;
    }
}
