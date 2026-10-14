using Microsoft.EntityFrameworkCore;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;

namespace Outcome.Infrastructure.Persistence.Repositories;

public sealed class DeviceTokenRepository(OutcomeDbContext db) : IDeviceTokenRepository
{
    /// <summary>
    /// Upsert by token. One statement on purpose: a SELECT followed by an INSERT is a race, and
    /// the app loses it routinely — it registers its tokens the moment a session opens, both
    /// reads miss, and the second INSERT dies on IX_device_tokens_token. That is a 500 on the
    /// first request after every login. ON CONFLICT makes the check and the write atomic.
    /// </summary>
    public Task RegisterAsync(long userId, string token, string platform, string kind, string? sessionHash = null, CancellationToken ct = default) =>
        // Postgres evaluates every right-hand side against the OLD row, so the Sandbox reset
        // still sees the previous owner even though user_id is being overwritten in the same
        // statement: same device, a different account after a re-login, and possibly a
        // differently-signed build, so what we knew about the gateway no longer holds.
        db.Database.ExecuteSqlAsync($"""
            INSERT INTO device_tokens (user_id, token, platform, kind, sandbox, session_hash)
            VALUES ({userId}, {token}, {platform}, {kind}, false, {sessionHash})
            ON CONFLICT (token) DO UPDATE SET
                sandbox      = CASE WHEN device_tokens.user_id <> EXCLUDED.user_id
                                    THEN false ELSE device_tokens.sandbox END,
                user_id      = EXCLUDED.user_id,
                platform     = EXCLUDED.platform,
                kind         = EXCLUDED.kind,
                session_hash = EXCLUDED.session_hash,
                last_seen    = now()
            """, ct);

    public Task RemoveAsync(string token, long? userId = null, CancellationToken ct = default) =>
        db.DeviceTokens.Where(d => d.Token == token && (userId == null || d.UserId == userId)).ExecuteDeleteAsync(ct);

    /// <summary>Tokens whose registering session is still alive (or that predate the binding).</summary>
    public async Task<IReadOnlyList<DeviceToken>> ListForUsersAsync(IReadOnlyCollection<long> userIds, string kind = "alert", CancellationToken ct = default)
    {
        if (userIds.Count == 0) return [];
        var now = DateTime.UtcNow;
        return await db.DeviceTokens.AsNoTracking()
            .Where(d => userIds.Contains(d.UserId) && d.Kind == kind)
            .Where(d => d.SessionHash == null
                        || db.Sessions.Any(s => s.Token == d.SessionHash && s.UserId == d.UserId && s.ExpiresAt > now))
            .ToListAsync(ct);
    }

    public Task MarkSandboxAsync(string token, CancellationToken ct = default) =>
        db.DeviceTokens.Where(d => d.Token == token)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.Sandbox, true), ct);
}
