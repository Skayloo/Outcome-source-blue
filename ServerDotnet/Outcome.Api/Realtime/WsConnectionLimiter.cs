using System.Collections.Concurrent;

namespace Outcome.Api.Realtime;

/// <summary>
/// Caps concurrent WebSocket connections per client IP — the cheap half of flood defence
/// (the expensive half, volumetric UDP floods, is an infrastructure problem). Counting is
/// per replica, so with N replicas the effective cap is N×; that's fine — the point is to
/// stop one box from parking thousands of idle sockets, not to meter exact quotas.
/// Configure with <c>Limits:WsMaxPerIp</c> (OUTCOME_Limits__WsMaxPerIp); default 64.
/// </summary>
public sealed class WsConnectionLimiter(IConfiguration config)
{
    private readonly ConcurrentDictionary<string, int> _perIp = new();
    private readonly int _maxPerIp = int.TryParse(config["Limits:WsMaxPerIp"], out var n) && n > 0 ? n : 64;

    /// <summary>Reserve a slot for this IP. False when the IP is already at its cap.</summary>
    public bool TryEnter(string ip)
    {
        while (true)
        {
            var current = _perIp.GetOrAdd(ip, 0);
            if (current >= _maxPerIp) return false;
            if (_perIp.TryUpdate(ip, current + 1, current)) return true;
            // Lost a race with another connection from the same IP — retry.
        }
    }

    /// <summary>Release the slot taken by <see cref="TryEnter"/> (call exactly once, in finally).</summary>
    public void Exit(string ip)
    {
        while (_perIp.TryGetValue(ip, out var current))
        {
            var next = current - 1;
            // Remove exhausted entries so the dictionary doesn't accumulate one key per IP ever seen.
            if (next <= 0
                ? _perIp.TryRemove(new KeyValuePair<string, int>(ip, current))
                : _perIp.TryUpdate(ip, next, current))
                return;
        }
    }
}
