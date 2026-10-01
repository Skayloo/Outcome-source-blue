using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class UserGifRepository(OutcomeDbContext db) : IUserGifRepository
{
    public async Task<IReadOnlyList<UserGif>> ListAsync(long userId, CancellationToken ct = default) =>
        await db.UserGifs.AsNoTracking()
            .Where(g => g.UserId == userId)
            .OrderByDescending(g => g.Id)
            .ToListAsync(ct);

    public Task<int> CountAsync(long userId, CancellationToken ct = default) =>
        db.UserGifs.CountAsync(g => g.UserId == userId, ct);

    public async Task<UserGif> AddAsync(UserGif gif, CancellationToken ct = default)
    {
        db.UserGifs.Add(gif);
        await db.SaveChangesAsync(ct);
        return gif;
    }

    public async Task<UserGif?> RemoveAsync(long userId, long id, CancellationToken ct = default)
    {
        var gif = await db.UserGifs.FirstOrDefaultAsync(g => g.Id == id && g.UserId == userId, ct);
        if (gif is null) return null;
        db.UserGifs.Remove(gif);
        await db.SaveChangesAsync(ct);
        return gif;
    }

    public Task<bool> IsGifPathAsync(string path, CancellationToken ct = default) =>
        db.UserGifs.AsNoTracking().AnyAsync(g => g.Path == path, ct);
}
