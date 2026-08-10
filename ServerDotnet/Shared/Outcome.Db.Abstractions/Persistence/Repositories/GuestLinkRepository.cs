using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class GuestLinkRepository(OutcomeDbContext db) : IGuestLinkRepository
{
    public async Task<IReadOnlyList<GuestLinkInfo>> ListForServerAsync(long serverId, CancellationToken ct = default)
    {
        var channels = await db.Channels.AsNoTracking()
            .Where(c => c.ServerId == serverId && c.Type == "voice" && !c.Deleted)
            .OrderBy(c => c.Position).ThenBy(c => c.Id)
            .Select(c => new { c.Id, c.Name })
            .ToListAsync(ct);
        if (channels.Count == 0) return [];

        var ids = channels.Select(c => c.Id).ToList();
        var links = await db.GuestLinks.AsNoTracking()
            .Where(g => ids.Contains(g.ChannelId) && !g.Revoked)
            .Select(g => new { g.ChannelId, g.Code })
            .ToDictionaryAsync(x => x.ChannelId, x => x.Code, ct);

        return channels
            .Select(c => new GuestLinkInfo(c.Id, c.Name, links.GetValueOrDefault(c.Id)))
            .ToList();
    }

    public async Task<GuestLink> GetOrCreateAsync(long channelId, long createdBy, CancellationToken ct = default)
    {
        var existing = await db.GuestLinks.AsNoTracking()
            .FirstOrDefaultAsync(g => g.ChannelId == channelId && !g.Revoked, ct);
        if (existing is not null) return existing;

        var link = new GuestLink
        {
            // 16 bytes of entropy — the code IS the credential, so it must be unguessable.
            Code = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)),
            ChannelId = channelId,
            CreatedBy = createdBy,
            CreatedAt = DateTime.UtcNow,
        };
        db.GuestLinks.Add(link);
        await db.SaveChangesAsync(ct);
        return link;
    }

    public Task<GuestLink?> GetByCodeAsync(string code, CancellationToken ct = default) =>
        db.GuestLinks.AsNoTracking().FirstOrDefaultAsync(g => g.Code == code && !g.Revoked, ct);

    public Task<string?> GetActiveCodeForChannelAsync(long channelId, CancellationToken ct = default) =>
        db.GuestLinks.AsNoTracking()
            .Where(g => g.ChannelId == channelId && !g.Revoked)
            .Select(g => g.Code)
            .FirstOrDefaultAsync(ct);

    public async Task<IReadOnlyList<long>> ListActiveChannelIdsAsync(CancellationToken ct = default) =>
        await db.GuestLinks.AsNoTracking()
            .Where(g => !g.Revoked)
            .Select(g => g.ChannelId)
            .Distinct()
            .ToListAsync(ct);

    public async Task<bool> RevokeAsync(long channelId, CancellationToken ct = default) =>
        await db.GuestLinks.Where(g => g.ChannelId == channelId && !g.Revoked)
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.Revoked, true), ct) > 0;
}
