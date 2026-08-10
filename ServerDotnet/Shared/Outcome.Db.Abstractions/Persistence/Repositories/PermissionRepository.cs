using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Authorization;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Infrastructure.Persistence.Repositories;

/// <summary>Claim-based permission storage over the Identity role_claims / user_claims tables.</summary>
public sealed class PermissionRepository(OutcomeDbContext db) : IPermissionRepository
{
    public async Task<IReadOnlyList<string>> GetEffectiveAsync(long userId, CancellationToken ct = default)
    {
        var roleId = await db.Users.Where(u => u.Id == userId).Select(u => u.RoleId).FirstOrDefaultAsync(ct);

        var userPerms = db.Set<IdentityUserClaim<long>>()
            .Where(c => c.UserId == userId && c.ClaimType == Permissions.ClaimType)
            .Select(c => c.ClaimValue!);
        var rolePerms = db.Set<IdentityRoleClaim<long>>()
            .Where(c => c.RoleId == roleId && c.ClaimType == Permissions.ClaimType)
            .Select(c => c.ClaimValue!);

        return await userPerms.Union(rolePerms).Distinct().ToListAsync(ct);
    }

    /// <summary>Permissions that are instance-wide (govern the whole deployment): a per-server role
    /// must NOT confer these — only the user's global role can.</summary>
    private static readonly HashSet<string> InstanceGlobalPerms = new()
    {
        Permissions.Administrator, Permissions.ManageRoles, Permissions.ManageServer,
        Permissions.BanMembers, Permissions.ViewAuditLog,
    };

    public async Task<IReadOnlyList<string>> GetEffectiveForServerAsync(long userId, long serverId, CancellationToken ct = default)
    {
        var globalRoleId = await db.Users.Where(u => u.Id == userId).Select(u => u.RoleId).FirstOrDefaultAsync(ct);
        var perServerRoleId = await db.ServerMembers.AsNoTracking()
            .Where(m => m.ServerId == serverId && m.UserId == userId)
            .Select(m => m.RoleId).FirstOrDefaultAsync(ct); // long? — null if not a member or unassigned

        var userPerms = await db.Set<IdentityUserClaim<long>>()
            .Where(c => c.UserId == userId && c.ClaimType == Permissions.ClaimType)
            .Select(c => c.ClaimValue!).ToListAsync(ct);
        var globalRolePerms = await db.Set<IdentityRoleClaim<long>>()
            .Where(c => c.RoleId == globalRoleId && c.ClaimType == Permissions.ClaimType)
            .Select(c => c.ClaimValue!).ToListAsync(ct);

        var result = new HashSet<string>(userPerms);
        result.UnionWith(globalRolePerms);

        // Layer the per-server role on top — server-scoped perms only (instance-global stripped).
        if (perServerRoleId is { } psr && psr != globalRoleId)
        {
            var perServerPerms = await db.Set<IdentityRoleClaim<long>>()
                .Where(c => c.RoleId == psr && c.ClaimType == Permissions.ClaimType)
                .Select(c => c.ClaimValue!).ToListAsync(ct);
            foreach (var p in perServerPerms)
                if (!InstanceGlobalPerms.Contains(p)) result.Add(p);
        }
        return result.ToList();
    }

    public async Task<IReadOnlyList<string>> GetForRoleAsync(long roleId, CancellationToken ct = default) =>
        await db.Set<IdentityRoleClaim<long>>()
            .Where(c => c.RoleId == roleId && c.ClaimType == Permissions.ClaimType)
            .Select(c => c.ClaimValue!)
            .ToListAsync(ct);

    public async Task AddToRoleAsync(long roleId, string permission, CancellationToken ct = default)
    {
        var exists = await db.Set<IdentityRoleClaim<long>>()
            .AnyAsync(c => c.RoleId == roleId && c.ClaimType == Permissions.ClaimType && c.ClaimValue == permission, ct);
        if (exists) return;

        db.Add(new IdentityRoleClaim<long> { RoleId = roleId, ClaimType = Permissions.ClaimType, ClaimValue = permission });
        await db.SaveChangesAsync(ct);
    }

    public Task RemoveFromRoleAsync(long roleId, string permission, CancellationToken ct = default) =>
        db.Set<IdentityRoleClaim<long>>()
            .Where(c => c.RoleId == roleId && c.ClaimType == Permissions.ClaimType && c.ClaimValue == permission)
            .ExecuteDeleteAsync(ct);

    public async Task SetForRoleAsync(long roleId, IEnumerable<string> permissions, CancellationToken ct = default)
    {
        await db.Set<IdentityRoleClaim<long>>()
            .Where(c => c.RoleId == roleId && c.ClaimType == Permissions.ClaimType)
            .ExecuteDeleteAsync(ct);

        foreach (var p in permissions.Distinct())
            db.Add(new IdentityRoleClaim<long> { RoleId = roleId, ClaimType = Permissions.ClaimType, ClaimValue = p });
        await db.SaveChangesAsync(ct);
    }

    // ── Direct user grants (user_claims) ─────────────────────────────────────
    public async Task<IReadOnlyList<string>> GetForUserAsync(long userId, CancellationToken ct = default) =>
        await db.Set<IdentityUserClaim<long>>()
            .Where(c => c.UserId == userId && c.ClaimType == Permissions.ClaimType)
            .Select(c => c.ClaimValue!)
            .ToListAsync(ct);

    public async Task AddToUserAsync(long userId, string permission, CancellationToken ct = default)
    {
        var exists = await db.Set<IdentityUserClaim<long>>()
            .AnyAsync(c => c.UserId == userId && c.ClaimType == Permissions.ClaimType && c.ClaimValue == permission, ct);
        if (exists) return;
        db.Add(new IdentityUserClaim<long> { UserId = userId, ClaimType = Permissions.ClaimType, ClaimValue = permission });
        await db.SaveChangesAsync(ct);
    }

    public Task RemoveFromUserAsync(long userId, string permission, CancellationToken ct = default) =>
        db.Set<IdentityUserClaim<long>>()
            .Where(c => c.UserId == userId && c.ClaimType == Permissions.ClaimType && c.ClaimValue == permission)
            .ExecuteDeleteAsync(ct);
}
