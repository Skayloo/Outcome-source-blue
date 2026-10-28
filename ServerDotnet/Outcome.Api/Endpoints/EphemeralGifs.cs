using System.Collections.Concurrent;
using StackExchange.Redis;

namespace Outcome.Api.Endpoints;

/// <summary>
/// A guest's GIF reaction: shown to the call and kept nowhere (the owner, 2026-10-28: "гости тоже
/// должны иметь возможность кидать гифки … кинули — она отображается и никуда не сохраняется"). The
/// animation is held in MEMORY for a minute — long enough for everyone in the call to load it — and
/// never written to the database, the bucket or a disk. It is served at a library GIF's path
/// (<c>/api/v1/files/eg-…</c>), so every client, the released apps included, already draws it.
///
/// Where the memory is: with Redis configured, Redis (a key that expires after the minute) — the deploy
/// kit runs two API replicas, and a participant whose request lands on the other one must see it too;
/// Redis runs there, as on production, with <c>--save "" --appendonly no</c>, so it stays off disk.
/// Without Redis, this process.
/// </summary>
public sealed class EphemeralGifs : IDisposable
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(60);

    /// <summary>The prefix of every id served from here: the file route asks only about these.</summary>
    public const string IdPrefix = "eg-";

    /// <summary>All guests of all spaces together, per minute — a burst cannot take the memory.</summary>
    private const long MaxTotalBytes = 64L * 1024 * 1024;

    private const string BytesKey = "eph-gif:bytes";
    private static readonly string[] Mimes = ["image/gif", "image/webp"];

    private sealed record Entry(byte[] Bytes, string Mime, DateTime Expires);

    private readonly IConnectionMultiplexer? redis;
    private readonly ConcurrentDictionary<string, Entry> local = new();
    private readonly Timer? sweeper;
    private long localTotal;

    public EphemeralGifs(IServiceProvider services)
    {
        redis = services.GetService<IConnectionMultiplexer>();
        if (redis is null) sweeper = new Timer(_ => Sweep(), null, Lifetime, TimeSpan.FromSeconds(15));
    }

    /// <summary>The id it is served under, or null when the memory set aside for them is full.</summary>
    public async Task<string?> AddAsync(long spaceId, byte[] bytes, string mime)
    {
        var id = IdPrefix + Guid.NewGuid().ToString("N");
        if (redis is not null)
        {
            var db = redis.GetDatabase();
            var used = await db.StringIncrementAsync(BytesKey, bytes.Length);
            await db.KeyExpireAsync(BytesKey, Lifetime, ExpireWhen.HasNoExpiry);
            if (used > MaxTotalBytes)
            {
                await db.StringDecrementAsync(BytesKey, bytes.Length);
                return null;
            }
            // One byte for the type ahead of the picture: one key, one round trip to read it back.
            var packed = new byte[bytes.Length + 1];
            packed[0] = (byte)Math.Max(0, Array.IndexOf(Mimes, mime));
            bytes.CopyTo(packed, 1);
            await db.StringSetAsync(Key(spaceId, id), packed, Lifetime);
            return id;
        }

        Sweep();
        if (Interlocked.Add(ref localTotal, bytes.Length) > MaxTotalBytes)
        {
            Interlocked.Add(ref localTotal, -bytes.Length);
            return null;
        }
        local[Key(spaceId, id)] = new Entry(bytes, mime, DateTime.UtcNow + Lifetime);
        return id;
    }

    public async Task<(byte[] Bytes, string Mime)?> GetAsync(long spaceId, string id)
    {
        if (!id.StartsWith(IdPrefix, StringComparison.Ordinal)) return null;
        if (redis is not null)
        {
            var v = (byte[]?)await redis.GetDatabase().StringGetAsync(Key(spaceId, id));
            return v is { Length: > 1 } ? (v[1..], Mimes[Math.Min(v[0], Mimes.Length - 1)]) : null;
        }
        return local.TryGetValue(Key(spaceId, id), out var e) && e.Expires > DateTime.UtcNow ? (e.Bytes, e.Mime) : null;
    }

    private static string Key(long spaceId, string id) => $"eph-gif:{spaceId}:{id}";

    private void Sweep()
    {
        var now = DateTime.UtcNow;
        foreach (var (key, e) in local)
            if (e.Expires <= now && local.TryRemove(key, out var gone))
                Interlocked.Add(ref localTotal, -gone.Bytes.Length);
    }

    public void Dispose() => sweeper?.Dispose();
}
