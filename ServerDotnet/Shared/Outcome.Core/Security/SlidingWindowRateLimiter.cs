using System.Collections.Concurrent;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Infrastructure.Security;

/// <summary>
/// In-memory sliding-window rate limiter with lockout, mirroring Server/auth/ratelimit.go.
/// <see cref="Allow"/> returns false once the count within the window exceeds the limit.
/// </summary>
public sealed class SlidingWindowRateLimiter : IRateLimiter
{
    /// <summary>One key's recorded hits and the longest window it has been asked about.</summary>
    private sealed class Bucket
    {
        public readonly List<long> Hits = [];
        public long WindowTicks;
    }

    private readonly ConcurrentDictionary<string, Bucket> _hits = new();
    private readonly ConcurrentDictionary<string, long> _lockouts = new();
    /// <summary>How often the sweep below runs, counted in calls rather than by a timer — this
    /// class has no lifetime of its own and a timer would keep the process awake for nothing.</summary>
    private const int SweepEvery = 4096;
    private int _sinceSweep;

    public bool Allow(string key, int limit, TimeSpan window)
    {
        var now = DateTime.UtcNow.Ticks;
        var cutoff = now - window.Ticks;
        var bucket = _hits.GetOrAdd(key, static _ => new Bucket());
        var list = bucket.Hits;
        bool allowed;
        lock (list)
        {
            if (window.Ticks > bucket.WindowTicks) bucket.WindowTicks = window.Ticks;
            list.RemoveAll(t => t < cutoff);
            // Only an ALLOWED request is recorded. Counting the refusals too was the difference
            // between "wait a minute" and "wait until you give up": every retry pushed the window
            // forward, so a user who did the obvious thing and clicked again could never come out
            // of it. A person who has just been told to wait is the most likely person in the
            // world to retry immediately.
            allowed = list.Count < limit;
            if (allowed) list.Add(now);
        }
        // Keys are client addresses. They were never removed, so the dictionary grew by one
        // entry per address seen since boot and never gave any of it back — one IPv6 client is
        // one address, and a scanner is as many as it likes.
        if (Interlocked.Increment(ref _sinceSweep) >= SweepEvery)
        {
            Interlocked.Exchange(ref _sinceSweep, 0);
            Sweep(now);
        }
        return allowed;
    }

    /// <summary>Drops keys whose hits have all aged out, and lockouts that have expired.
    /// A key that is still in use is refilled by the very next call, so losing it costs
    /// nothing; the window it would have remembered is empty by definition.
    /// Each key by ITS OWN window: the sweep used the window of whichever call happened to trigger
    /// it, so a one-minute call wiped every 15-minute budget (reset mails per address, deletion
    /// password failures, the contact form) every 4096 requests.</summary>
    private void Sweep(long now)
    {
        foreach (var (k, b) in _hits)
        {
            bool empty;
            lock (b.Hits)
            {
                var cutoff = now - b.WindowTicks;
                b.Hits.RemoveAll(t => t < cutoff);
                empty = b.Hits.Count == 0;
            }
            if (empty) _hits.TryRemove(new KeyValuePair<string, Bucket>(k, b));
        }
        foreach (var (k, until) in _lockouts)
            if (until <= now) _lockouts.TryRemove(new KeyValuePair<string, long>(k, until));
    }

    public void Reset(string key) => _hits.TryRemove(key, out _);

    public bool IsLockedOut(string key) =>
        _lockouts.TryGetValue(key, out var until) && until > DateTime.UtcNow.Ticks;

    public void Lockout(string key, TimeSpan duration) =>
        _lockouts[key] = DateTime.UtcNow.Add(duration).Ticks;
}
