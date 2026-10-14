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
        var owner = await db.Servers.AsNoTracking().Where(s => s.Id == serverId && !s.Deleted).Select(s => (long?)s.OwnerId).FirstOrDefaultAsync(ct);
        var member = await db.ServerMembers.AsNoTracking()
            .Where(m => m.ServerId == serverId && m.UserId == userId)
            .Select(m => new { m.RoleId }).FirstOrDefaultAsync(ct);
        var serverRole = owner is null ? Outcome.Domain.Permissions.ServerRole.None
            : Outcome.Domain.Permissions.ServerRoles.FromMember(owner == userId, member is not null, member?.RoleId);

        var userPerms = await db.Set<IdentityUserClaim<long>>()
            .Where(c => c.UserId == userId && c.ClaimType == Permissions.ClaimType)
            .Select(c => c.ClaimValue!).ToListAsync(ct);
        var globalRolePerms = await db.Set<IdentityRoleClaim<long>>()
            .Where(c => c.RoleId == globalRoleId && c.ClaimType == Permissions.ClaimType)
            .Select(c => c.ClaimValue!).ToListAsync(ct);

        var result = new HashSet<string>(userPerms);
        result.UnionWith(globalRolePerms);

        // The role INSIDE the server adds a fixed, server-scoped set (ServerRoles.Grant). It used to
        // add that role's role_claims minus InstanceGlobalPerms — the same rows as the space roles,
        // so a server "Admin" (claim: Administrator) was stripped to nothing, and a server
        // "Moderator" carried KickMembers into handlers that act on the whole space.
        foreach (var p in Permissions.FromBits(Outcome.Domain.Permissions.ServerRoles.Grant(serverRole)))
            if (!InstanceGlobalPerms.Contains(p)) result.Add(p);
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
