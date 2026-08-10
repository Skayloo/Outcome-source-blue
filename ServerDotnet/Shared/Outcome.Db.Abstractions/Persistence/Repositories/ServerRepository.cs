using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class ServerRepository(OutcomeDbContext db) : IServerRepository
{
    public async Task<IReadOnlyList<ServerInfo>> ListForUserAsync(long userId, CancellationToken ct = default)
    {
        var rows = await db.ServerMembers.AsNoTracking()
            .Where(m => m.UserId == userId)
            .Join(db.Servers.AsNoTracking().Where(s => !s.Deleted), m => m.ServerId, s => s.Id, (m, s) => s)
            .OrderBy(s => s.Id)
            .Select(s => new { s.Id, s.Name, s.OwnerId, s.Icon, s.CustomDomain })
            .ToListAsync(ct);
        return rows.Select(r => new ServerInfo(r.Id, r.Name, r.OwnerId, r.Icon, r.CustomDomain)).ToList();
    }

    public async Task<IReadOnlyList<ServerInfo>> ListAllAsync(int limit = int.MaxValue, int offset = 0, CancellationToken ct = default)
    {
        var rows = await db.Servers.AsNoTracking().Where(s => !s.Deleted)
            .OrderBy(s => s.Id).Skip(offset).Take(limit)
            .Select(s => new { s.Id, s.Name, s.OwnerId, s.Icon }).ToListAsync(ct);
        return rows.Select(r => new ServerInfo(r.Id, r.Name, r.OwnerId, r.Icon)).ToList();
    }

    public Task<int> CountAllAsync(CancellationToken ct = default) =>
        db.Servers.AsNoTracking().CountAsync(s => !s.Deleted, ct);

    public async Task<bool> AdminDeleteAsync(long serverId, CancellationToken ct = default)
    {
        // Force-delete ANY server (instance admin) — no owner check. Members removed, then soft-deleted.
        var server = await db.Servers.FirstOrDefaultAsync(s => s.Id == serverId && !s.Deleted, ct);
        if (server is null) return false;
        await db.ServerMembers.Where(m => m.ServerId == serverId).ExecuteDeleteAsync(ct);
        server.Deleted = true;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public Task<int> CountOwnedAsync(long ownerId, CancellationToken ct = default) =>
        db.Servers.AsNoTracking().CountAsync(s => s.OwnerId == ownerId && !s.Deleted, ct);

    public async Task<bool> SoftDeleteAsync(long serverId, long requesterId, CancellationToken ct = default)
    {
        var server = await db.Servers.FirstOrDefaultAsync(s => s.Id == serverId && !s.Deleted, ct);
        if (server is null || server.OwnerId != requesterId) return false;
        // Kick all members first, then mark deleted.
        await db.ServerMembers.Where(m => m.ServerId == serverId).ExecuteDeleteAsync(ct);
        server.Deleted = true;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<long> GetFirstForUserAsync(long userId, CancellationToken ct = default) =>
        await db.ServerMembers.AsNoTracking()
            .Where(m => m.UserId == userId)
            .OrderBy(m => m.ServerId)
            .Select(m => m.ServerId)
            .FirstOrDefaultAsync(ct);

    public Task<bool> IsMemberAsync(long serverId, long userId, CancellationToken ct = default) =>
        db.ServerMembers.AsNoTracking().AnyAsync(m => m.ServerId == serverId && m.UserId == userId, ct);

    public async Task<ServerInfo?> GetAsync(long serverId, CancellationToken ct = default)
    {
        var s = await db.Servers.AsNoTracking().Where(x => x.Id == serverId)
            .Select(x => new { x.Id, x.Name, x.OwnerId, x.Icon, x.CustomDomain })
            .FirstOrDefaultAsync(ct);
        return s is null ? null : new ServerInfo(s.Id, s.Name, s.OwnerId, s.Icon, s.CustomDomain);
    }

    public async Task<bool> AdminSetCustomDomainAsync(long serverId, string? domain, CancellationToken ct = default) =>
        await db.Servers.Where(s => s.Id == serverId && !s.Deleted)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.CustomDomain, domain), ct) > 0;

    public async Task<IReadOnlyDictionary<long, int>> MemberCountsAsync(IReadOnlyCollection<long> serverIds, CancellationToken ct = default)
    {
        if (serverIds.Count == 0) return new Dictionary<long, int>();
        var rows = await db.ServerMembers.AsNoTracking()
            .Where(m => serverIds.Contains(m.ServerId))
            .GroupBy(m => m.ServerId)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToListAsync(ct);
        return rows.ToDictionary(x => x.Key, x => x.Count);
    }

    public async Task<ServerInfo?> FindByCustomDomainAsync(string domain, CancellationToken ct = default)
    {
        var s = await db.Servers.AsNoTracking().Where(x => x.CustomDomain == domain && !x.Deleted)
            .Select(x => new { x.Id, x.Name, x.OwnerId, x.Icon, x.CustomDomain })
            .FirstOrDefaultAsync(ct);
        return s is null ? null : new ServerInfo(s.Id, s.Name, s.OwnerId, s.Icon, s.CustomDomain);
    }

    public async Task<ServerInfo> CreateAsync(string name, long ownerId, CancellationToken ct = default)
    {
        var server = new Server { Name = name, OwnerId = ownerId };
        db.Servers.Add(server);
        await db.SaveChangesAsync(ct);

        db.Channels.Add(new Channel { ServerId = server.Id, Name = "general", Type = "text", Category = "Text Channels", Topic = "Welcome!" });
        db.Channels.Add(new Channel { ServerId = server.Id, Name = "General", Type = "voice", Category = "Voice Channels" });
        db.ServerMembers.Add(new ServerMember { ServerId = server.Id, UserId = ownerId, RoleId = null });
        await db.SaveChangesAsync(ct);

        return new ServerInfo(server.Id, server.Name, server.OwnerId, server.Icon);
    }

    public async Task AddMemberAsync(long serverId, long userId, long? roleId, CancellationToken ct = default)
    {
        if (await db.ServerMembers.AnyAsync(m => m.ServerId == serverId && m.UserId == userId, ct)) return;
        db.ServerMembers.Add(new ServerMember { ServerId = serverId, UserId = userId, RoleId = roleId });
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> RemoveMemberAsync(long serverId, long userId, CancellationToken ct = default) =>
        await db.ServerMembers.Where(m => m.ServerId == serverId && m.UserId == userId).ExecuteDeleteAsync(ct) > 0;

    public async Task<bool> RenameAsync(long serverId, string name, CancellationToken ct = default) =>
        await db.Servers.Where(s => s.Id == serverId && !s.Deleted)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.Name, name), ct) > 0;

    public async Task<bool> SetIconAsync(long serverId, string? icon, CancellationToken ct = default) =>
        await db.Servers.Where(s => s.Id == serverId && !s.Deleted)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.Icon, icon), ct) > 0;

    public async Task<bool> SetCustomDomainAsync(long serverId, long ownerId, string? domain, CancellationToken ct = default) =>
        await db.Servers.Where(s => s.Id == serverId && s.OwnerId == ownerId && !s.Deleted)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.CustomDomain, domain), ct) > 0;

    public Task<long?> GetMemberRoleAsync(long serverId, long userId, CancellationToken ct = default) =>
        db.ServerMembers.AsNoTracking()
            .Where(m => m.ServerId == serverId && m.UserId == userId)
            .Select(m => m.RoleId)
            .FirstOrDefaultAsync(ct);

    public async Task<bool> AssignMemberRoleAsync(long serverId, long userId, long? roleId, CancellationToken ct = default) =>
        await db.ServerMembers.Where(m => m.ServerId == serverId && m.UserId == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.RoleId, roleId), ct) > 0;

    // ── Public "Explore" directory ───────────────────────────────────────────
    public async Task<IReadOnlyList<PublicServerInfo>> DiscoverAsync(long userId, CancellationToken ct = default)
    {
        var joined = db.ServerMembers.AsNoTracking().Where(m => m.UserId == userId).Select(m => m.ServerId);
        var rows = await db.Servers.AsNoTracking()
            .Where(s => s.IsPublic && !s.Deleted && !joined.Contains(s.Id))
            .OrderByDescending(s => db.ServerMembers.Count(m => m.ServerId == s.Id))
            .Select(s => new
            {
                s.Id, s.Name, s.Description, s.Icon,
                Members = db.ServerMembers.Count(m => m.ServerId == s.Id),
            })
            .Take(100)
            .ToListAsync(ct);
        return rows.Select(r => new PublicServerInfo(r.Id, r.Name, r.Description, r.Icon, r.Members)).ToList();
    }

    public async Task<ServerVisibility?> GetVisibilityAsync(long serverId, CancellationToken ct = default)
    {
        var s = await db.Servers.AsNoTracking().Where(x => x.Id == serverId && !x.Deleted)
            .Select(x => new { x.IsPublic, x.Description }).FirstOrDefaultAsync(ct);
        return s is null ? null : new ServerVisibility(s.IsPublic, s.Description);
    }

    public async Task<bool> SetVisibilityAsync(long serverId, long ownerId, bool isPublic, string description, CancellationToken ct = default)
    {
        var desc = (description ?? string.Empty).Trim();
        if (desc.Length > 280) desc = desc[..280];
        return await db.Servers.Where(s => s.Id == serverId && s.OwnerId == ownerId && !s.Deleted)
            .ExecuteUpdateAsync(u => u
                .SetProperty(s => s.IsPublic, isPublic)
                .SetProperty(s => s.Description, desc), ct) > 0;
    }

    public async Task<ServerInfo?> JoinPublicAsync(long serverId, long userId, CancellationToken ct = default)
    {
        var server = await db.Servers.AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == serverId && s.IsPublic && !s.Deleted, ct);
        if (server is null) return null;
        if (!await db.ServerMembers.AnyAsync(m => m.ServerId == serverId && m.UserId == userId, ct))
        {
            db.ServerMembers.Add(new ServerMember { ServerId = serverId, UserId = userId, RoleId = null });
            await db.SaveChangesAsync(ct);
        }
        return new ServerInfo(server.Id, server.Name, server.OwnerId, server.Icon);
    }
}
