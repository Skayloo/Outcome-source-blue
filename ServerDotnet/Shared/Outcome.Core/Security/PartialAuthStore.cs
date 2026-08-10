using System.Security.Cryptography;
using Microsoft.Extensions.Caching.Memory;
using Outcome.Shared.Abstractions.Security;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Infrastructure.Security;

/// <summary>In-memory partial 2FA challenge store (TTL 10 min, configurable failure budget).</summary>
public sealed class PartialAuthStore(IMemoryCache cache, ICurrentSpace space) : IPartialAuthStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

    private sealed class Entry
    {
        public required PartialChallenge Challenge { get; init; }
        public int Failures;
    }

    private string Key(string token) => $"partial_auth:s{space.Space.Id}:" + token;

    public string Issue(long userId, string? device, string ip)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        cache.Set(Key(token), new Entry { Challenge = new PartialChallenge(userId, device, ip) }, Ttl);
        return token;
    }

    public string IssueWithCode(long userId, string? device, string ip, string code)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        cache.Set(Key(token), new Entry { Challenge = new PartialChallenge(userId, device, ip, code) }, Ttl);
        return token;
    }

    public PartialChallenge? Lookup(string partialToken) =>
        cache.TryGetValue(Key(partialToken), out Entry? e) ? e!.Challenge : null;

    public PartialChallenge? Consume(string partialToken)
    {
        if (!cache.TryGetValue(Key(partialToken), out Entry? e)) return null;
        cache.Remove(Key(partialToken));
        return e!.Challenge;
    }

    public void RegisterFailure(string partialToken, int maxFailures)
    {
        if (!cache.TryGetValue(Key(partialToken), out Entry? e)) return;
        if (Interlocked.Increment(ref e!.Failures) >= maxFailures)
            cache.Remove(Key(partialToken));
    }
}
