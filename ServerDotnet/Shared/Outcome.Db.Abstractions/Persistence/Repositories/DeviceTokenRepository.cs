using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class DeviceTokenRepository(OutcomeDbContext db) : IDeviceTokenRepository
{
    public async Task RegisterAsync(long userId, string token, string platform, string kind, CancellationToken ct = default)
    {
        var existing = await db.DeviceTokens.FirstOrDefaultAsync(d => d.Token == token, ct);
        if (existing is null)
        {
            db.DeviceTokens.Add(new DeviceToken { UserId = userId, Token = token, Platform = platform, Kind = kind });
        }
        else
        {
            // Same device, possibly a different account after a re-login. Reassigning also
            // resets Sandbox: a token that moved could have come from a differently-signed build.
            if (existing.UserId != userId) existing.Sandbox = false;
            existing.UserId = userId;
            existing.Platform = platform;
            existing.Kind = kind;
            existing.LastSeen = DateTime.UtcNow;
        }
        await db.SaveChangesAsync(ct);
    }

    public Task RemoveAsync(string token, long? userId = null, CancellationToken ct = default) =>
        db.DeviceTokens.Where(d => d.Token == token && (userId == null || d.UserId == userId)).ExecuteDeleteAsync(ct);

    public async Task<IReadOnlyList<DeviceToken>> ListForUsersAsync(IReadOnlyCollection<long> userIds, string kind = "alert", CancellationToken ct = default) =>
        userIds.Count == 0
            ? []
            : await db.DeviceTokens.AsNoTracking()
                .Where(d => userIds.Contains(d.UserId) && d.Kind == kind).ToListAsync(ct);

    public Task MarkSandboxAsync(string token, CancellationToken ct = default) =>
        db.DeviceTokens.Where(d => d.Token == token)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.Sandbox, true), ct);
}
