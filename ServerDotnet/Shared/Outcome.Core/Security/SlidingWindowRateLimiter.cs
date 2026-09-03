using System.Collections.Concurrent;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Infrastructure.Security;

/// <summary>
/// In-memory sliding-window rate limiter with lockout, mirroring Server/auth/ratelimit.go.
/// <see cref="Allow"/> returns false once the count within the window exceeds the limit.
/// </summary>
public sealed class SlidingWindowRateLimiter : IRateLimiter
{
    private readonly ConcurrentDictionary<string, List<long>> _hits = new();
    private readonly ConcurrentDictionary<string, long> _lockouts = new();
    /// <summary>How often the sweep below runs, counted in calls rather than by a timer — this
    /// class has no lifetime of its own and a timer would keep the process awake for nothing.</summary>
    private const int SweepEvery = 4096;
    private int _sinceSweep;

    public bool Allow(string key, int limit, TimeSpan window)
    {
        var now = DateTime.UtcNow.Ticks;
        var cutoff = now - window.Ticks;
        var list = _hits.GetOrAdd(key, static _ => []);
        bool allowed;
        lock (list)
        {
            list.RemoveAll(t => t < cutoff);
            list.Add(now);
            allowed = list.Count <= limit;
        }
        // Keys are client addresses. They were never removed, so the dictionary grew by one
        // entry per address seen since boot and never gave any of it back — one IPv6 client is
        // one address, and a scanner is as many as it likes.
        if (Interlocked.Increment(ref _sinceSweep) >= SweepEvery)
        {
            Interlocked.Exchange(ref _sinceSweep, 0);
            Sweep(now, window);
        }
        return allowed;
    }

    /// <summary>Drops keys whose hits have all aged out, and lockouts that have expired.
    /// A key that is still in use is refilled by the very next call, so losing it costs
    /// nothing; the window it would have remembered is empty by definition.</summary>
    private void Sweep(long now, TimeSpan window)
    {
        var cutoff = now - window.Ticks;
        foreach (var (k, v) in _hits)
        {
            bool empty;
            lock (v)
            {
                v.RemoveAll(t => t < cutoff);
                empty = v.Count == 0;
            }
            if (empty) _hits.TryRemove(new KeyValuePair<string, List<long>>(k, v));
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
