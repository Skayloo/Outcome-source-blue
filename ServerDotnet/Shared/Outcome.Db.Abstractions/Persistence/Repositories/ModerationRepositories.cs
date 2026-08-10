using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class BlockRepository(OutcomeDbContext db) : IBlockRepository
{
    public async Task BlockAsync(long blockerId, long blockedId, CancellationToken ct = default)
    {
        if (await db.UserBlocks.AnyAsync(b => b.BlockerId == blockerId && b.BlockedId == blockedId, ct))
            return;
        db.UserBlocks.Add(new UserBlock { BlockerId = blockerId, BlockedId = blockedId, CreatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> UnblockAsync(long blockerId, long blockedId, CancellationToken ct = default) =>
        await db.UserBlocks
            .Where(b => b.BlockerId == blockerId && b.BlockedId == blockedId)
            .ExecuteDeleteAsync(ct) > 0;

    public Task<bool> IsBlockedEitherWayAsync(long a, long b, CancellationToken ct = default) =>
        db.UserBlocks.AsNoTracking().AnyAsync(
            x => (x.BlockerId == a && x.BlockedId == b) || (x.BlockerId == b && x.BlockedId == a), ct);

    public async Task<IReadOnlyList<BlockedUserDto>> ListForUserAsync(long userId, CancellationToken ct = default)
    {
        // Order BEFORE projecting: EF can't translate an OrderBy over a constructed DTO
        // (it has no SQL column to sort by) and throws at query-compile time.
        var rows = await db.UserBlocks.AsNoTracking().Where(b => b.BlockerId == userId)
            .Join(db.Users.AsNoTracking(), b => b.BlockedId, u => u.Id,
                (b, u) => new { u.Id, u.UserName, u.Avatar, b.CreatedAt })
            .OrderBy(x => x.UserName)
            .ToListAsync(ct);
        return rows.Select(r => new BlockedUserDto(r.Id, r.UserName!, r.Avatar, r.CreatedAt)).ToList();
    }
}

public sealed class MessageReportRepository(OutcomeDbContext db) : IMessageReportRepository
{
    public async Task<long> CreateAsync(MessageReport report, CancellationToken ct = default)
    {
        db.MessageReports.Add(report);
        await db.SaveChangesAsync(ct);
        return report.Id;
    }

    public async Task<IReadOnlyList<MessageReportDto>> ListAllAsync(int limit = int.MaxValue, int offset = 0, CancellationToken ct = default)
    {
        var rows = await db.MessageReports.AsNoTracking()
            .OrderByDescending(r => r.Id)
            .Skip(offset).Take(limit)
            .ToListAsync(ct);
        if (rows.Count == 0) return [];

        // Reporter/author usernames joined in one query (either may be a deleted account by now).
        var ids = rows.Select(r => r.ReporterId).Concat(rows.Select(r => r.AuthorId)).Distinct().ToList();
        var names = await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .Select(u => new { u.Id, u.UserName })
            .ToDictionaryAsync(x => x.Id, x => x.UserName!, ct);

        return rows.Select(r => new MessageReportDto(
            r.Id, r.ReporterId, names.GetValueOrDefault(r.ReporterId, "deleted user"),
            r.MessageId, r.AuthorId, names.GetValueOrDefault(r.AuthorId, "deleted user"),
            r.Content, r.Reason, r.Status, r.CreatedAt)).ToList();
    }

    public Task<int> CountAsync(CancellationToken ct = default) =>
        db.MessageReports.AsNoTracking().CountAsync(ct);

    public async Task<bool> SetStatusAsync(long id, string status, CancellationToken ct = default) =>
        await db.MessageReports.Where(r => r.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.Status, status), ct) > 0;
}
