using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class ReadStateRepository(OutcomeDbContext db) : IReadStateRepository
{
    public async Task<long> MarkReadAsync(long userId, long channelId, CancellationToken ct = default)
    {
        var lastId = await db.Messages.AsNoTracking()
            .Where(m => m.ChannelId == channelId)
            .MaxAsync(m => (long?)m.Id, ct) ?? 0;

        var updated = await db.ReadStates
            .Where(r => r.UserId == userId && r.ChannelId == channelId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(r => r.LastMessageId, lastId)
                .SetProperty(r => r.MentionCount, 0), ct);
        if (updated == 0)
        {
            db.ReadStates.Add(new ReadState { UserId = userId, ChannelId = channelId, LastMessageId = lastId });
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException) { /* concurrent insert from another device — equally fresh */ }
        }
        return lastId;
    }

    public async Task<IReadOnlyDictionary<long, long>> MaxOtherReadAsync(
        long userId, IReadOnlyCollection<long> channelIds, CancellationToken ct = default)
    {
        if (channelIds.Count == 0) return new Dictionary<long, long>();
        var rows = await db.ReadStates.AsNoTracking()
            .Where(r => channelIds.Contains(r.ChannelId) && r.UserId != userId)
            .GroupBy(r => r.ChannelId)
            .Select(g => new { g.Key, Max = g.Max(r => r.LastMessageId) })
            .ToListAsync(ct);
        return rows.ToDictionary(x => x.Key, x => x.Max);
    }

    public async Task<IReadOnlyDictionary<long, int>> UnreadCountsAsync(
        long userId, IReadOnlyCollection<long> channelIds, CancellationToken ct = default)
    {
        if (channelIds.Count == 0) return new Dictionary<long, int>();
        var rows = await (
            from m in db.Messages.AsNoTracking()
            where channelIds.Contains(m.ChannelId) && m.UserId != userId && !m.Deleted
            join r0 in db.ReadStates.AsNoTracking().Where(r => r.UserId == userId)
                on m.ChannelId equals r0.ChannelId into rs
            from r in rs.DefaultIfEmpty()
            where m.Id > (r == null ? 0 : r.LastMessageId)
            group m by m.ChannelId into g
            select new { g.Key, Count = g.Count() }).ToListAsync(ct);
        return rows.ToDictionary(x => x.Key, x => x.Count);
    }
}
