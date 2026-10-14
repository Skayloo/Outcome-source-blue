using System.Security.Cryptography;
using System.Text.Json;
using Outcome.Shared.Abstractions.Security;
using StackExchange.Redis;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Infrastructure.Security;

/// <summary>Redis-backed <see cref="IPendingRegistrationStore"/> for replicated deployments:
/// the register call that parked the entry and the verify call that completes it can land on
/// different replicas. Same TTL/failure semantics as the in-memory store.</summary>
public sealed class RedisPendingRegistrationStore(IConnectionMultiplexer redis, ICurrentSpace space) : IPendingRegistrationStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    private readonly IDatabase _db = redis.GetDatabase();

    private sealed record Entry(PendingRegistration Reg, int Failures);

    private string Key(string token) => $"outcome:s{space.Space.Id}:pendingreg:" + token;

    public string Issue(PendingRegistration reg)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        _db.StringSet(Key(token), JsonSerializer.Serialize(new Entry(reg, 0)), Ttl);
        return token;
    }

    public PendingRegistration? Lookup(string token) => Load(token)?.Reg;

    public PendingRegistration? Consume(string token)
    {
        _db.KeyDelete(FailKey(token));
        var raw = _db.StringGetDelete(Key(token));
        if (raw.IsNullOrEmpty) return null;
        return JsonSerializer.Deserialize<Entry>((string)raw!)?.Reg;
    }

    private string FailKey(string token) => Key(token) + ":f";

    public void RegisterFailure(string token, int maxFailures)
    {
        if (!_db.KeyExists(Key(token))) return;
        // INCR, not read-bump-write: parallel wrong codes all read the same count (RedisPartialAuthStore).
        var failures = _db.StringIncrement(FailKey(token));
        if (failures == 1) _db.KeyExpire(FailKey(token), Ttl);
        if (failures >= maxFailures)
        {
            _db.KeyDelete(Key(token));
            _db.KeyDelete(FailKey(token));
        }
    }

    private Entry? Load(string token)
    {
        var raw = _db.StringGet(Key(token));
        return raw.IsNullOrEmpty ? null : JsonSerializer.Deserialize<Entry>((string)raw!);
    }
}
