using System.Collections.Concurrent;

namespace Outcome.Api.Endpoints;

/// <summary>
/// A guest's GIF reaction: shown to the call and kept nowhere (the owner, 2026-10-28: "гости тоже
/// должны иметь возможность кидать гифки … кинули — она отображается и никуда не сохраняется"). The
/// animation lives in this process's memory for a minute — long enough for everyone in the call to
/// load it — and is never written to the database, the bucket or the disk. It is served at the path
/// a library GIF has (<c>/api/v1/files/{id}</c>), so every client, the released apps included,
/// already draws it. One replica only: with several, a participant whose request lands on another
/// one would get a 404 and see nothing (the same limit as guest presence).
/// </summary>
public sealed class EphemeralGifs : IDisposable
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(60);

    /// <summary>All guests of all spaces together — a burst cannot take the server's memory.</summary>
    private const long MaxTotalBytes = 64L * 1024 * 1024;

    private sealed record Entry(byte[] Bytes, string Mime, DateTime Expires);

    private readonly ConcurrentDictionary<string, Entry> entries = new();
    private readonly Timer sweeper;
    private long total;

    public EphemeralGifs() => sweeper = new Timer(_ => Sweep(), null, Lifetime, TimeSpan.FromSeconds(15));

    /// <summary>The id it is served under, or null when the memory set aside for them is full.</summary>
    public string? Add(long spaceId, byte[] bytes, string mime)
    {
        Sweep();
        if (Interlocked.Add(ref total, bytes.Length) > MaxTotalBytes)
        {
            Interlocked.Add(ref total, -bytes.Length);
            return null;
        }
        var id = Guid.NewGuid().ToString();
        entries[Key(spaceId, id)] = new Entry(bytes, mime, DateTime.UtcNow + Lifetime);
        return id;
    }

    public (byte[] Bytes, string Mime)? Get(long spaceId, string id) =>
        entries.TryGetValue(Key(spaceId, id), out var e) && e.Expires > DateTime.UtcNow ? (e.Bytes, e.Mime) : null;

    private static string Key(long spaceId, string id) => $"{spaceId}:{id}";

    private void Sweep()
    {
        var now = DateTime.UtcNow;
        foreach (var (key, e) in entries)
            if (e.Expires <= now && entries.TryRemove(key, out var gone))
                Interlocked.Add(ref total, -gone.Bytes.Length);
    }

    public void Dispose() => sweeper.Dispose();
}
