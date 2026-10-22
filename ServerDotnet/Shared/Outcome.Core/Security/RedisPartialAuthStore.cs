using System.Security.Cryptography;
using System.Text.Json;
using Outcome.Shared.Abstractions.Security;
using StackExchange.Redis;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Infrastructure.Security;

/// <summary>
/// Redis-backed partial 2FA challenge store (TTL 10 min). Used when the API runs with
/// multiple replicas: the login that issued the challenge and the verify call that consumes
/// it can land on different replicas, so the challenge must live in shared storage.
/// </summary>
public sealed class RedisPartialAuthStore(IConnectionMultiplexer redis, ICurrentSpace space) : IPartialAuthStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    private readonly IDatabase _db = redis.GetDatabase();

    private sealed record Entry(long UserId, string? Device, string Ip, int Failures);

    private string Key(string token) => $"outcome:s{space.Space.Id}:partial:" + token;

    public string Issue(long userId, string? device, string ip) => Store(new Entry(userId, device, ip, 0));

    private string Store(Entry entry)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        _db.StringSet(Key(token), JsonSerializer.Serialize(entry), Ttl);
        return token;
    }

    public PartialChallenge? Lookup(string partialToken) => Load(partialToken) is { } e
        ? new PartialChallenge(e.UserId, e.Device, e.Ip)
        : null;

    public PartialChallenge? Consume(string partialToken)
    {
        var raw = _db.StringGetDelete(Key(partialToken));
        _db.KeyDelete(FailKey(partialToken));
        if (raw.IsNullOrEmpty) return null;
        var e = JsonSerializer.Deserialize<Entry>((string)raw!);
        return e is null ? null : new PartialChallenge(e.UserId, e.Device, e.Ip);
    }

    private string FailKey(string token) => Key(token) + ":f";

    public void RegisterFailure(string partialToken, int maxFailures)
    {
        if (!_db.KeyExists(Key(partialToken))) return;
        // INCR, not read-bump-write: parallel wrong codes each read the same count and wrote back the
        // same "+1", so the five-guess budget stretched with the number of requests in flight.
        var failures = _db.StringIncrement(FailKey(partialToken));
        if (failures == 1) _db.KeyExpire(FailKey(partialToken), Ttl);
        if (failures >= maxFailures)
        {
            _db.KeyDelete(Key(partialToken));
            _db.KeyDelete(FailKey(partialToken));
        }
    }

    private Entry? Load(string token)
    {
        var raw = _db.StringGet(Key(token));
        return raw.IsNullOrEmpty ? null : JsonSerializer.Deserialize<Entry>((string)raw!);
    }
}
