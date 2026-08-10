using System.Security.Cryptography;
using Microsoft.Extensions.Caching.Memory;
using Outcome.Shared.Abstractions.Security;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Infrastructure.Security;

/// <inheritdoc cref="IPendingRegistrationStore"/>
public sealed class PendingRegistrationStore(IMemoryCache cache, ICurrentSpace space) : IPendingRegistrationStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

    private sealed class Entry
    {
        public required PendingRegistration Reg { get; init; }
        public int Failures;
    }

    private string Key(string token) => $"pending_reg:s{space.Space.Id}:" + token;

    public string Issue(PendingRegistration reg)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        cache.Set(Key(token), new Entry { Reg = reg }, Ttl);
        return token;
    }

    public PendingRegistration? Lookup(string token) =>
        cache.TryGetValue(Key(token), out Entry? e) ? e!.Reg : null;

    public PendingRegistration? Consume(string token)
    {
        if (!cache.TryGetValue(Key(token), out Entry? e)) return null;
        cache.Remove(Key(token));
        return e!.Reg;
    }

    public void RegisterFailure(string token, int maxFailures)
    {
        if (!cache.TryGetValue(Key(token), out Entry? e)) return;
        if (Interlocked.Increment(ref e!.Failures) >= maxFailures)
            cache.Remove(Key(token));
    }
}
