using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Voice;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class VoiceStateRepository(OutcomeDbContext db) : IVoiceStateRepository
{
    public async Task UpsertJoinAsync(long userId, long channelId, CancellationToken ct = default)
    {
        var existing = await db.VoiceStates.FirstOrDefaultAsync(v => v.UserId == userId, ct);
        if (existing is null)
        {
            db.VoiceStates.Add(new VoiceState { UserId = userId, ChannelId = channelId });
        }
        else
        {
            existing.ChannelId = channelId;
            existing.Muted = existing.Deafened = existing.Speaking = existing.Camera = existing.Screenshare = false;
        }
        await db.SaveChangesAsync(ct);
    }

    public Task ClearAsync(long userId, CancellationToken ct = default) =>
        db.VoiceStates.Where(v => v.UserId == userId).ExecuteDeleteAsync(ct);

    public async Task<bool> ClearIfInChannelAsync(long userId, long channelId, CancellationToken ct = default) =>
        await db.VoiceStates.Where(v => v.UserId == userId && v.ChannelId == channelId).ExecuteDeleteAsync(ct) > 0;

    public Task SetFlagAsync(long userId, VoiceFlag flag, bool value, CancellationToken ct = default)
    {
        var q = db.VoiceStates.Where(v => v.UserId == userId);
        return flag switch
        {
            VoiceFlag.Muted => q.ExecuteUpdateAsync(s => s.SetProperty(v => v.Muted, value), ct),
            VoiceFlag.Deafened => q.ExecuteUpdateAsync(s => s.SetProperty(v => v.Deafened, value), ct),
            VoiceFlag.Speaking => q.ExecuteUpdateAsync(s => s.SetProperty(v => v.Speaking, value), ct),
            VoiceFlag.Camera => q.ExecuteUpdateAsync(s => s.SetProperty(v => v.Camera, value), ct),
            VoiceFlag.Screenshare => q.ExecuteUpdateAsync(s => s.SetProperty(v => v.Screenshare, value), ct),
            _ => Task.CompletedTask,
        };
    }

    public async Task<VoiceStateDto?> GetAsync(long userId, CancellationToken ct = default)
    {
        var row = await (from v in db.VoiceStates.AsNoTracking()
                         where v.UserId == userId
                         join u in db.Users.AsNoTracking() on v.UserId equals u.Id
                         select new { v, Username = u.UserName! }).FirstOrDefaultAsync(ct);
        return row is null ? null : Map(row.v, row.Username);
    }

    public async Task<IReadOnlyList<VoiceStateDto>> GetForChannelAsync(long channelId, CancellationToken ct = default)
    {
        var rows = await (from v in db.VoiceStates.AsNoTracking()
                          where v.ChannelId == channelId
                          join u in db.Users.AsNoTracking() on v.UserId equals u.Id
                          select new { v, Username = u.UserName! }).ToListAsync(ct);
        return rows.Select(r => Map(r.v, r.Username)).ToList();
    }

    public async Task<IReadOnlyList<VoiceStateDto>> GetAllAsync(CancellationToken ct = default)
    {
        var rows = await (from v in db.VoiceStates.AsNoTracking()
                          join u in db.Users.AsNoTracking() on v.UserId equals u.Id
                          select new { v, Username = u.UserName! }).ToListAsync(ct);
        return rows.Select(r => Map(r.v, r.Username)).ToList();
    }

    public async Task<IReadOnlyList<VoiceStateDto>> GetForServerAsync(long serverId, long userId, CancellationToken ct = default)
    {
        // Tenant-scoped READY payload: voice states in the active server's channels, plus states
        // in DM channels the REQUESTING user participates in (their own 1-on-1 calls). Other
        // servers' voice presence is never shipped to this connection.
        var rows = await (from v in db.VoiceStates.AsNoTracking()
                          join c in db.Channels.AsNoTracking() on v.ChannelId equals c.Id
                          where c.ServerId == serverId
                                || (c.ServerId == null && db.DmParticipants.Any(p => p.ChannelId == c.Id && p.UserId == userId))
                          join u in db.Users.AsNoTracking() on v.UserId equals u.Id
                          select new { v, Username = u.UserName! }).ToListAsync(ct);
        return rows.Select(r => Map(r.v, r.Username)).ToList();
    }

    public Task<int> CountForChannelAsync(long channelId, CancellationToken ct = default) =>
        db.VoiceStates.CountAsync(v => v.ChannelId == channelId, ct);

    private static VoiceStateDto Map(VoiceState v, string username) =>
        new(v.ChannelId, v.UserId, username, v.Muted, v.Deafened, v.Speaking, v.Camera, v.Screenshare);
}
