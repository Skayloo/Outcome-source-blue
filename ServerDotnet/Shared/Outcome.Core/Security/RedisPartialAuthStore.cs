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

    private sealed record Entry(long UserId, string? Device, string Ip, string? Code, int Failures);

    private string Key(string token) => $"outcome:s{space.Space.Id}:partial:" + token;

    public string Issue(long userId, string? device, string ip) => Store(new Entry(userId, device, ip, null, 0));

    public string IssueWithCode(long userId, string? device, string ip, string code) =>
        Store(new Entry(userId, device, ip, code, 0));

    private string Store(Entry entry)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        _db.StringSet(Key(token), JsonSerializer.Serialize(entry), Ttl);
        return token;
    }

    public PartialChallenge? Lookup(string partialToken) => Load(partialToken) is { } e
        ? new PartialChallenge(e.UserId, e.Device, e.Ip, e.Code)
        : null;

    public PartialChallenge? Consume(string partialToken)
    {
        var raw = _db.StringGetDelete(Key(partialToken));
        if (raw.IsNullOrEmpty) return null;
        var e = JsonSerializer.Deserialize<Entry>((string)raw!);
        return e is null ? null : new PartialChallenge(e.UserId, e.Device, e.Ip, e.Code);
    }

    public void RegisterFailure(string partialToken, int maxFailures)
    {
        var e = Load(partialToken);
        if (e is null) return;
        var failures = e.Failures + 1;
        if (failures >= maxFailures)
        {
            _db.KeyDelete(Key(partialToken));
            return;
        }
        // Preserve the remaining TTL when writing the bumped failure count back.
        var ttl = _db.KeyTimeToLive(Key(partialToken)) ?? Ttl;
        _db.StringSet(Key(partialToken), JsonSerializer.Serialize(e with { Failures = failures }), ttl);
    }

    private Entry? Load(string token)
    {
        var raw = _db.StringGet(Key(token));
        return raw.IsNullOrEmpty ? null : JsonSerializer.Deserialize<Entry>((string)raw!);
    }
}
