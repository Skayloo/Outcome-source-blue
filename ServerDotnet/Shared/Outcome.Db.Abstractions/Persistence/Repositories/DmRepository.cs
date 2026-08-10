using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Dm;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class DmRepository(OutcomeDbContext db) : IDmRepository
{
    public async Task<long?> FindChannelAsync(long userA, long userB, CancellationToken ct = default)
    {
        var ids = await (
            from p1 in db.DmParticipants.AsNoTracking()
            join p2 in db.DmParticipants.AsNoTracking() on p1.ChannelId equals p2.ChannelId
            join c in db.Channels.AsNoTracking() on p1.ChannelId equals c.Id
            where p1.UserId == userA && p2.UserId == userB && c.Type == "dm"
            select p1.ChannelId).Take(1).ToListAsync(ct);
        return ids.Count > 0 ? ids[0] : null;
    }

    public async Task<long> CreateChannelAsync(long userA, long userB, CancellationToken ct = default)
    {
        var channel = new Channel { Name = string.Empty, Type = "dm" };
        db.Channels.Add(channel);
        await db.SaveChangesAsync(ct);

        db.DmParticipants.AddRange(
            new DmParticipant { ChannelId = channel.Id, UserId = userA },
            new DmParticipant { ChannelId = channel.Id, UserId = userB });
        db.DmOpenStates.AddRange(
            new DmOpenState { UserId = userA, ChannelId = channel.Id },
            new DmOpenState { UserId = userB, ChannelId = channel.Id });
        await db.SaveChangesAsync(ct);

        return channel.Id;
    }

    public async Task OpenAsync(long userId, long channelId, CancellationToken ct = default)
    {
        if (await db.DmOpenStates.AnyAsync(o => o.UserId == userId && o.ChannelId == channelId, ct)) return;
        db.DmOpenStates.Add(new DmOpenState { UserId = userId, ChannelId = channelId });
        await db.SaveChangesAsync(ct);
    }

    public Task CloseAsync(long userId, long channelId, CancellationToken ct = default) =>
        db.DmOpenStates.Where(o => o.UserId == userId && o.ChannelId == channelId).ExecuteDeleteAsync(ct);

    public Task<bool> IsParticipantAsync(long userId, long channelId, CancellationToken ct = default) =>
        db.DmParticipants.AnyAsync(p => p.UserId == userId && p.ChannelId == channelId, ct);

    public async Task<IReadOnlyList<long>> GetParticipantIdsAsync(long channelId, CancellationToken ct = default) =>
        await db.DmParticipants.AsNoTracking().Where(p => p.ChannelId == channelId).Select(p => p.UserId).ToListAsync(ct);

    public async Task<IReadOnlyList<DmChannelInfoDto>> ListForUserAsync(long userId, CancellationToken ct = default)
    {
        var rows = await (
            from os in db.DmOpenStates.AsNoTracking()
            where os.UserId == userId
            join p in db.DmParticipants.AsNoTracking() on os.ChannelId equals p.ChannelId
            where p.UserId != userId
            join u in db.Users.AsNoTracking() on p.UserId equals u.Id
            select new { os.ChannelId, u.Id, Username = u.UserName!, u.Avatar, u.Status, u.PublicKey }).ToListAsync(ct);

        var chIds = rows.Select(r => r.ChannelId).ToList();

        // Last (non-deleted) message per channel — the sidebar preview and sort key.
        var lastIds = await db.Messages.AsNoTracking()
            .Where(m => chIds.Contains(m.ChannelId) && !m.Deleted)
            .GroupBy(m => m.ChannelId)
            .Select(g => g.Max(m => m.Id))
            .ToListAsync(ct);
        var lastMsgs = await db.Messages.AsNoTracking()
            .Where(m => lastIds.Contains(m.Id))
            .Select(m => new { m.ChannelId, m.Id, m.Content, m.Timestamp })
            .ToDictionaryAsync(m => m.ChannelId, ct);

        // Unread per channel: messages after this user's read marker, not authored by them —
        // the same server-side truth READY ships for server channels.
        var unread = await (
            from m in db.Messages.AsNoTracking()
            where chIds.Contains(m.ChannelId) && m.UserId != userId && !m.Deleted
            join r0 in db.ReadStates.AsNoTracking().Where(r => r.UserId == userId)
                on m.ChannelId equals r0.ChannelId into rs
            from r in rs.DefaultIfEmpty()
            where m.Id > (r == null ? 0 : r.LastMessageId)
            group m by m.ChannelId into g
            select new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count, ct);

        // The peer's read marker per channel — the sender's ✓✓ ticks.
        var peerReads = await (
            from p in db.DmParticipants.AsNoTracking()
            where chIds.Contains(p.ChannelId) && p.UserId != userId
            join r0 in db.ReadStates.AsNoTracking() on p.ChannelId equals r0.ChannelId
            where r0.UserId == p.UserId
            group r0 by p.ChannelId into g
            select new { g.Key, Max = g.Max(r => r.LastMessageId) }).ToDictionaryAsync(x => x.Key, x => x.Max, ct);

        return rows
            .Select(r =>
            {
                var last = lastMsgs.TryGetValue(r.ChannelId, out var lm) ? lm : null;
                return new DmChannelInfoDto(
                    r.ChannelId,
                    new DmUserDto(r.Id, r.Username, r.Avatar ?? string.Empty, r.Status, r.PublicKey),
                    last?.Id,
                    last?.Content ?? string.Empty,
                    last?.Timestamp.ToString("o") ?? string.Empty,
                    unread.TryGetValue(r.ChannelId, out var uc) ? uc : 0,
                    peerReads.TryGetValue(r.ChannelId, out var pr) ? pr : 0);
            })
            .ToList();
    }
}
