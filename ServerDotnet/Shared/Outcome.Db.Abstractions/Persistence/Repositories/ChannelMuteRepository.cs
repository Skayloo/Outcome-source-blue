using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class ChannelMuteRepository(OutcomeDbContext db) : IChannelMuteRepository
{
    public async Task SetAsync(long userId, long channelId, bool muted, CancellationToken ct = default)
    {
        if (muted)
        {
            if (await db.ChannelMutes.AnyAsync(m => m.UserId == userId && m.ChannelId == channelId, ct)) return;
            db.ChannelMutes.Add(new ChannelMute { UserId = userId, ChannelId = channelId });
            await db.SaveChangesAsync(ct);
        }
        else
        {
            await db.ChannelMutes.Where(m => m.UserId == userId && m.ChannelId == channelId).ExecuteDeleteAsync(ct);
        }
    }

    public async Task<IReadOnlyList<long>> ListForUserAsync(long userId, CancellationToken ct = default) =>
        await db.ChannelMutes.AsNoTracking().Where(m => m.UserId == userId).Select(m => m.ChannelId).ToListAsync(ct);
}
