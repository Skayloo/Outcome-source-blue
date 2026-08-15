using Microsoft.Extensions.Caching.Memory;
using Outcome.Shared.Abstractions.Security;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Infrastructure.Security;

/// <summary>In-memory pending TOTP enrollment store (secret awaiting confirmation, TTL 10 min).</summary>
public sealed class PendingTotpStore(IMemoryCache cache, ICurrentSpace space) : IPendingTotpStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

    // The space belongs in the key: IMemoryCache is one instance for the whole process, while each
    // space is its own database with its own id sequence. Without it, "user 5" enrolling in one
    // space and "user 5" in another share a pending secret — two different people.
    private string Key(long userId) => $"pending_totp:s{space.Space.Id}:{userId}";

    public void Put(long userId, string secret) => cache.Set(Key(userId), secret, Ttl);

    public string? Get(long userId) => cache.TryGetValue(Key(userId), out string? secret) ? secret : null;

    public void Delete(long userId) => cache.Remove(Key(userId));
}
