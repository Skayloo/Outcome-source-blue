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

    public bool Allow(string key, int limit, TimeSpan window)
    {
        var now = DateTime.UtcNow.Ticks;
        var cutoff = now - window.Ticks;
        var list = _hits.GetOrAdd(key, static _ => []);
        lock (list)
        {
            list.RemoveAll(t => t < cutoff);
            list.Add(now);
            return list.Count <= limit;
        }
    }

    public void Reset(string key) => _hits.TryRemove(key, out _);

    public bool IsLockedOut(string key) =>
        _lockouts.TryGetValue(key, out var until) && until > DateTime.UtcNow.Ticks;

    public void Lockout(string key, TimeSpan duration) =>
        _lockouts[key] = DateTime.UtcNow.Add(duration).Ticks;
}
