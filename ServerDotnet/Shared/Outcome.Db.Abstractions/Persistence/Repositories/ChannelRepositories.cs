using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Channels;
using Outcome.Application.Search;
using Outcome.Domain.Entities;

using Outcome.Shared.Abstractions.Security;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class ChannelRepository(OutcomeDbContext db) : IChannelRepository
{
    public async Task<IReadOnlyList<Channel>> ListAsync(long serverId, CancellationToken ct = default) =>
        await db.Channels.AsNoTracking().Where(c => c.ServerId == serverId && !c.Deleted)
            .OrderBy(c => c.Position).ThenBy(c => c.Id).ToListAsync(ct);

    public Task<Channel?> GetByIdAsync(long id, CancellationToken ct = default) =>
        db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id && !c.Deleted, ct);

    public async Task<long> CreateAsync(Channel channel, CancellationToken ct = default)
    {
        db.Channels.Add(channel);
        await db.SaveChangesAsync(ct);
        return channel.Id;
    }

    public async Task<bool> UpdateAsync(long id, string? name, string? topic, int? slowMode, int? position, bool? archived, CancellationToken ct = default) =>
        await db.Channels.Where(c => c.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(c => c.Name, c => name ?? c.Name)
            .SetProperty(c => c.Topic, c => topic ?? c.Topic)
            .SetProperty(c => c.SlowMode, c => slowMode ?? c.SlowMode)
            .SetProperty(c => c.Position, c => position ?? c.Position)
            .SetProperty(c => c.Archived, c => archived ?? c.Archived), ct) > 0;

    // Soft delete: the channel and all its rows (messages, overrides, …) stay in the DB but the
    // channel is excluded from listings and lookups, so it disappears from every client.
    public async Task<bool> DeleteAsync(long id, CancellationToken ct = default) =>
        await db.Channels.Where(c => c.Id == id && !c.Deleted).ExecuteUpdateAsync(s => s
            .SetProperty(c => c.Deleted, true)
            .SetProperty(c => c.DeletedAt, DateTime.UtcNow), ct) > 0;
}

public sealed class EmojiRepository(OutcomeDbContext db) : IEmojiRepository
{
    public async Task<IReadOnlyList<Emoji>> ListAsync(CancellationToken ct = default) =>
        await db.Emojis.AsNoTracking().OrderBy(e => e.Shortcode).ToListAsync(ct);

    public async Task<bool> DeleteAsync(long id, CancellationToken ct = default) =>
        await db.Emojis.Where(e => e.Id == id).ExecuteDeleteAsync(ct) > 0;
}

public sealed class SoundRepository(OutcomeDbContext db) : ISoundRepository
{
    public async Task<IReadOnlyList<Sound>> ListAsync(CancellationToken ct = default) =>
        await db.Sounds.AsNoTracking().OrderBy(s => s.Name).ToListAsync(ct);

    public async Task<bool> DeleteAsync(long id, CancellationToken ct = default) =>
        await db.Sounds.Where(s => s.Id == id).ExecuteDeleteAsync(ct) > 0;
}

public sealed class ChannelOverrideRepository(OutcomeDbContext db) : IChannelOverrideRepository
{
    public async Task<IReadOnlyDictionary<long, (IReadOnlySet<string> Allow, IReadOnlySet<string> Deny)>> GetForRoleAsync(long roleId, CancellationToken ct = default)
    {
        var rows = await db.ChannelOverrideClaims.AsNoTracking()
            .Where(o => o.RoleId == roleId)
            .Select(o => new { o.ChannelId, o.Permission, o.Effect })
            .ToListAsync(ct);

        return rows.GroupBy(r => r.ChannelId).ToDictionary(
            g => g.Key,
            g => (
                Allow: (IReadOnlySet<string>)g.Where(x => x.Effect == ChannelOverrideClaim.EffectAllow).Select(x => x.Permission).ToHashSet(),
                Deny:  (IReadOnlySet<string>)g.Where(x => x.Effect == ChannelOverrideClaim.EffectDeny).Select(x => x.Permission).ToHashSet()));
    }
}

public sealed class MessageRepository(OutcomeDbContext db, IFileUrlSigner fileUrls) : IMessageRepository
{
    public async Task<IReadOnlyList<MessageDto>> GetForApiAsync(long channelId, long before, int limit, long requestingUserId, CancellationToken ct = default, bool pinnedOnly = false)
    {
        var q = db.Messages.AsNoTracking().Where(m => m.ChannelId == channelId && !m.Deleted);
        if (pinnedOnly) q = q.Where(m => m.Pinned);
        if (before > 0) q = q.Where(m => m.Id < before);

        var msgs = await q.OrderByDescending(m => m.Id).Take(limit)
            .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => new
            {
                m.Id, m.ChannelId, m.UserId, Username = u.UserName!, u.Avatar,
                m.Content, m.ReplyTo, m.ForwardedFrom, m.EditedAt, m.Deleted, m.Pinned, m.Timestamp,
            })
            .ToListAsync(ct);
        if (msgs.Count == 0) return [];

        var ids = msgs.Select(m => m.Id).ToList();

        // ORDER BY, or an album is shuffled. Without it Postgres returns the rows however the
        // plan happens to produce them — in practice the primary key, which is a random GUID —
        // so photos arrive in an order unrelated to the one they were sent in. Position is the
        // sender's own order, recorded when the message was created; upload time only catches
        // rows written before that column existed, and id makes the result stable either way.
        var atts = await db.Attachments.AsNoTracking()
            .Where(a => a.MessageId != null && ids.Contains(a.MessageId.Value))
            .OrderBy(a => a.Position ?? int.MaxValue).ThenBy(a => a.UploadedAt).ThenBy(a => a.Id)
            .Select(a => new { a.Id, MessageId = a.MessageId!.Value, a.Filename, a.Size, a.MimeType, a.Width, a.Height, a.DurationMs, a.Waveform })
            .ToListAsync(ct);

        var reactRows = await db.Reactions.AsNoTracking()
            .Where(r => ids.Contains(r.MessageId))
            .Select(r => new { r.MessageId, r.Emoji, r.UserId })
            .ToListAsync(ct);

        // Which voice attachments the REQUESTING user has already played (their listened state).
        var attIds = atts.Select(a => a.Id).ToList();
        var listened = attIds.Count == 0
            ? new HashSet<string>()
            : (await db.VoiceListens.AsNoTracking()
                .Where(v => v.UserId == requestingUserId && attIds.Contains(v.AttachmentId))
                .Select(v => v.AttachmentId)
                .ToListAsync(ct)).ToHashSet();
        // ...and which of them anyone ELSE has played — the SENDER's unlistened dot.
        var listenedByOthers = attIds.Count == 0
            ? new HashSet<string>()
            : (await db.VoiceListens.AsNoTracking()
                .Where(v => v.UserId != requestingUserId && attIds.Contains(v.AttachmentId))
                .Select(v => v.AttachmentId)
                .Distinct()
                .ToListAsync(ct)).ToHashSet();

        var attByMsg = atts.GroupBy(a => a.MessageId).ToDictionary(
            g => g.Key,
            g => (IReadOnlyList<AttachmentInfoDto>)g.Select(a =>
                new AttachmentInfoDto(a.Id, a.Filename, a.Size, a.MimeType, fileUrls.Sign(a.Id), a.Width, a.Height, a.DurationMs, a.Waveform, listened.Contains(a.Id), listenedByOthers.Contains(a.Id))).ToList());

        var reactByMsg = reactRows.GroupBy(r => r.MessageId).ToDictionary(
            g => g.Key,
            g => (IReadOnlyList<ReactionInfoDto>)g.GroupBy(r => r.Emoji).Select(eg =>
                new ReactionInfoDto(eg.Key, eg.Count(), eg.Any(r => r.UserId == requestingUserId))).ToList());

        IReadOnlyList<AttachmentInfoDto> noAtts = [];
        IReadOnlyList<ReactionInfoDto> noReacts = [];

        return msgs.Select(m => new MessageDto(
            m.Id, m.ChannelId, new UserPublicDto(m.UserId, m.Username, m.Avatar), m.Content, m.ReplyTo,
            attByMsg.GetValueOrDefault(m.Id, noAtts), reactByMsg.GetValueOrDefault(m.Id, noReacts),
            m.Pinned, m.EditedAt, m.Deleted, m.Timestamp, m.ForwardedFrom)).ToList();
    }

    public async Task<(long Id, DateTime Timestamp)> CreateAsync(long channelId, long userId, string content, long? replyTo, string? forwardedFrom = null, CancellationToken ct = default)
    {
        var msg = new Message { ChannelId = channelId, UserId = userId, Content = content, ReplyTo = replyTo, ForwardedFrom = forwardedFrom };
        db.Messages.Add(msg);
        await db.SaveChangesAsync(ct);
        return (msg.Id, msg.Timestamp);
    }

    public Task<Message?> GetByIdAsync(long id, CancellationToken ct = default) =>
        db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == id, ct);

    public async Task<DateTime?> EditAsync(long id, long userId, string content, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var rows = await db.Messages
            .Where(m => m.Id == id && m.UserId == userId && !m.Deleted)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.Content, content).SetProperty(m => m.EditedAt, now), ct);
        return rows > 0 ? now : null;
    }

    public async Task<bool> DeleteAsync(long id, long userId, bool isMod, CancellationToken ct = default)
    {
        var q = db.Messages.Where(m => m.Id == id && !m.Deleted);
        if (!isMod) q = q.Where(m => m.UserId == userId);
        // Tombstone AND blank the body: a "deleted" message is never shown again, so keeping
        // its text (or its E2EE ciphertext) on disk buys nothing and leaks everything.
        var rows = await q.ExecuteUpdateAsync(
            s => s.SetProperty(m => m.Deleted, true).SetProperty(m => m.Content, string.Empty), ct);
        return rows > 0;
    }

    public async Task<bool> PurgeAsync(long id, CancellationToken ct = default) =>
        await db.Messages.Where(m => m.Id == id).ExecuteDeleteAsync(ct) > 0;

    public async Task<bool> SetPinnedAsync(long channelId, long messageId, bool pinned, CancellationToken ct = default) =>
        await db.Messages.Where(m => m.Id == messageId && m.ChannelId == channelId && !m.Deleted)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.Pinned, pinned), ct) > 0;

    public async Task<IReadOnlyList<SearchRow>> SearchAsync(string query, long? channelId, int limit, CancellationToken ct = default)
    {
        var q = db.Messages.AsNoTracking().Where(m => !m.Deleted &&
            EF.Functions.ToTsVector("simple", m.Content).Matches(EF.Functions.WebSearchToTsQuery("simple", query)));
        if (channelId is { } cid) q = q.Where(m => m.ChannelId == cid);

        return await q.OrderByDescending(m => m.Id).Take(limit)
            .Join(db.Channels.AsNoTracking(), m => m.ChannelId, c => c.Id, (m, c) => new { m, c })
            .Join(db.Users.AsNoTracking(), mc => mc.m.UserId, u => u.Id, (mc, u) =>
                new SearchRow(mc.m.Id, mc.m.ChannelId, mc.c.Name, mc.c.Type, u.Id, u.UserName!, u.Avatar, mc.m.Content, mc.m.Timestamp))
            .ToListAsync(ct);
    }
}

public sealed class ReactionRepository(OutcomeDbContext db) : IReactionRepository
{
    public async Task AddAsync(long messageId, long userId, string emoji, CancellationToken ct = default)
    {
        var exists = await db.Reactions.AnyAsync(r => r.MessageId == messageId && r.UserId == userId && r.Emoji == emoji, ct);
        if (exists) return;
        db.Reactions.Add(new Reaction { MessageId = messageId, UserId = userId, Emoji = emoji });
        await db.SaveChangesAsync(ct);
    }

    public Task RemoveAsync(long messageId, long userId, string emoji, CancellationToken ct = default) =>
        db.Reactions.Where(r => r.MessageId == messageId && r.UserId == userId && r.Emoji == emoji).ExecuteDeleteAsync(ct);
}
