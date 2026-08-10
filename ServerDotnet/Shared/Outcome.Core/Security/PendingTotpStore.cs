using Microsoft.Extensions.Caching.Memory;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Infrastructure.Security;

/// <summary>In-memory pending TOTP enrollment store (secret awaiting confirmation, TTL 10 min).</summary>
public sealed class PendingTotpStore(IMemoryCache cache) : IPendingTotpStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

    private static string Key(long userId) => "pending_totp:" + userId;

    public void Put(long userId, string secret) => cache.Set(Key(userId), secret, Ttl);

    public string? Get(long userId) => cache.TryGetValue(Key(userId), out string? secret) ? secret : null;

    public void Delete(long userId) => cache.Remove(Key(userId));
}
