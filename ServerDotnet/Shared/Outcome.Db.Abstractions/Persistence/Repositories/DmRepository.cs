using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Dm;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class DmRepository(OutcomeDbContext db) : IDmRepository
{
    public async Task<long?> FindChannelAsync(long userA, long userB, CancellationToken ct = default)
    {
        // A conversation with yourself is not one. The join below matches a participant row
        // against ITSELF when both ids are the same, so it happily returns some channel the
        // user is in — which is how a moderator answering their own report had the answer land
        // in an unrelated one-person DM instead of anywhere they would ever look.
        if (userA == userB) return null;

        var ids = await (
            from p1 in db.DmParticipants.AsNoTracking()
            join p2 in db.DmParticipants.AsNoTracking() on p1.ChannelId equals p2.ChannelId
            join c in db.Channels.AsNoTracking() on p1.ChannelId equals c.Id
            where p1.UserId == userA && p2.UserId == userB && c.Type == "dm"
            // Oldest wins, and it has to be spelled out: nothing stops a pair from ending up with
            // two dm channels (opening one is itself a find-then-create race), and an unordered
            // Take(1) lets Postgres hand each side a different one — two people typing into two
            // channels, each seeing an empty conversation.
            orderby p1.ChannelId
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
            select new { os.ChannelId, u.Id, Username = u.UserName!, u.Avatar, u.Status }).ToListAsync(ct);

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

        // The first file on each of those messages. A photo sent without a caption stores an
        // empty Content, so without this the sidebar row shows a name and nothing under it and
        // the conversation reads as empty. Position orders the files the way the sender picked
        // them; it is null on rows written before that column existed, hence the upload-time
        // fallback that matches how the message view orders them.
        var lastAtt = await db.Attachments.AsNoTracking()
            .Where(a => a.MessageId != null && lastIds.Contains(a.MessageId!.Value))
            .OrderBy(a => a.Position ?? int.MaxValue).ThenBy(a => a.UploadedAt)
            .Select(a => new { MessageId = a.MessageId!.Value, a.MimeType, a.DurationMs })
            .ToListAsync(ct);
        var attByMsg = lastAtt
            .GroupBy(a => a.MessageId)
            .ToDictionary(g => g.Key, g => g.First());

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
                var att = last != null && attByMsg.TryGetValue(last.Id, out var a) ? a : null;
                return new DmChannelInfoDto(
                    r.ChannelId,
                    new DmUserDto(r.Id, r.Username, r.Avatar ?? string.Empty, r.Status),
                    last?.Id,
                    last?.Content ?? string.Empty,
                    last?.Timestamp.ToString("o") ?? string.Empty,
                    unread.TryGetValue(r.ChannelId, out var uc) ? uc : 0,
                    peerReads.TryGetValue(r.ChannelId, out var pr) ? pr : 0,
                    att?.MimeType,
                    att?.DurationMs);
            })
            // Newest conversation first, the way every messenger orders this list. The comment
            // above called the last message "the sort key" and nothing ever sorted by it, so the
            // order was whatever the join happened to produce — stable enough to look deliberate.
            // Ordering by message id, not timestamp: ids are monotonic and need no parsing, and
            // a channel with no messages yet sorts last rather than first.
            .OrderByDescending(d => d.LastMessageId ?? 0)
            .ToList();
    }
}
