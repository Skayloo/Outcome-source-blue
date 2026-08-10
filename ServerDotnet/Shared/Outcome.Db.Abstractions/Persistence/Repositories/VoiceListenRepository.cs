using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class VoiceListenRepository(OutcomeDbContext db) : IVoiceListenRepository
{
    public async Task MarkAsync(long userId, string attachmentId, CancellationToken ct = default)
    {
        if (await db.VoiceListens.AnyAsync(v => v.UserId == userId && v.AttachmentId == attachmentId, ct)) return;
        db.VoiceListens.Add(new VoiceListen { UserId = userId, AttachmentId = attachmentId });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { /* concurrent mark, or a bogus attachment id — both fine */ }
    }

    public async Task<IReadOnlySet<string>> ListenedSetAsync(
        long userId, IReadOnlyCollection<string> attachmentIds, CancellationToken ct = default)
    {
        if (attachmentIds.Count == 0) return new HashSet<string>();
        var ids = await db.VoiceListens.AsNoTracking()
            .Where(v => v.UserId == userId && attachmentIds.Contains(v.AttachmentId))
            .Select(v => v.AttachmentId)
            .ToListAsync(ct);
        return ids.ToHashSet();
    }
}
