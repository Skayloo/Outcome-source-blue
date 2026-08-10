namespace Outcome.Shared.Abstractions.Persistence;

/// <summary>Claim-based permissions (mirrors api_mobstra_analytics): permissions live as
/// role_claims / user_claims of type "Permissions". Effective = user claims UNION the claims of
/// the user's role.</summary>
public interface IPermissionRepository
{
    Task<IReadOnlyList<string>> GetEffectiveAsync(long userId, CancellationToken ct = default);
    /// <summary>Effective permissions for the user IN a specific server (tenant): their global-role +
    /// user claims, PLUS the server-scoped claims of their per-server role (<c>server_members.role_id</c>)
    /// with instance-global powers (Administrator/ManageRoles/ManageServer/BanMembers/ViewAuditLog)
    /// stripped — so a per-server role can run its own server but never the instance. When the user has
    /// no per-server role assignment this is identical to <see cref="GetEffectiveAsync"/>.</summary>
    Task<IReadOnlyList<string>> GetEffectiveForServerAsync(long userId, long serverId, CancellationToken ct = default);
    Task<IReadOnlyList<string>> GetForRoleAsync(long roleId, CancellationToken ct = default);
    Task AddToRoleAsync(long roleId, string permission, CancellationToken ct = default);
    Task RemoveFromRoleAsync(long roleId, string permission, CancellationToken ct = default);
    /// <summary>Replaces a role's permission claims with exactly the given set (used on role create/edit).</summary>
    Task SetForRoleAsync(long roleId, IEnumerable<string> permissions, CancellationToken ct = default);

    /// <summary>Extra permissions granted DIRECTLY to a user (user_claims), layered on top of their role.</summary>
    Task<IReadOnlyList<string>> GetForUserAsync(long userId, CancellationToken ct = default);
    Task AddToUserAsync(long userId, string permission, CancellationToken ct = default);
    Task RemoveFromUserAsync(long userId, string permission, CancellationToken ct = default);
}
