using System.Collections.Concurrent;
using Outcome.Shared.Abstractions.Realtime;

namespace Outcome.Realtime;

/// <summary>
/// Thread-safe registry of live WebSocket connections, grouped by user. A user may hold
/// MULTIPLE simultaneous connections (phone + desktop + a second tab), and every one of them
/// receives fan-out — so a second login never silently blinds the first. Each connection
/// exposes a <c>send</c> delegate that enqueues onto its own single-writer pump, so fan-out
/// never writes to a socket concurrently.
/// </summary>
/// <remarks>
/// Keying by userId ALONE (one entry per user) was a latent bug: a second connection for the
/// same user evicted the first from the map, leaving that socket open-but-deaf — it still sent
/// (and still answered pings, so the client heartbeat never noticed) but received no broadcasts.
/// </remarks>
public sealed class ConnectionRegistry : IConnectionHub
{
    private sealed record Entry(Guid Id, long ServerId, Func<byte[], ValueTask> Send, Action Close);

    // (spaceId, userId) -> (connectionId -> entry). The space is part of the key because ids
    // are tenant-local: user 5 in one space and user 5 in another are different people.
    // Inner map is never left empty in the outer map.
    private readonly ConcurrentDictionary<(long SpaceId, long UserId), ConcurrentDictionary<Guid, Entry>> _byUser = new();
    // Serialises structural changes (add/remove/re-tag) so an empty-bucket cleanup can't race a
    // concurrent add and orphan it. Broadcasts stay lock-free (snapshot enumeration).
    private readonly object _gate = new();

    /// <summary>Distinct users with at least one live connection (health reports this).</summary>
    public int Count => _byUser.Count;

    public void Add(long spaceId, long userId, Guid connectionId, long serverId, Func<byte[], ValueTask> send, Action close)
    {
        lock (_gate)
        {
            var conns = _byUser.GetOrAdd((spaceId, userId), static _ => new ConcurrentDictionary<Guid, Entry>());
            conns[connectionId] = new Entry(connectionId, serverId, send, close);
        }
    }

    public void UpdateServer(long spaceId, long userId, Guid connectionId, long serverId)
    {
        // Re-tag the tenant on ONE connection (keeps its Send/Close) so its broadcasts route to
        // the newly-viewed server. Locked so it can't resurrect a concurrently-removed connection.
        lock (_gate)
        {
            if (_byUser.TryGetValue((spaceId, userId), out var conns) && conns.TryGetValue(connectionId, out var e))
                conns[connectionId] = e with { ServerId = serverId };
        }
    }

    public Task CloseUserAsync(long spaceId, long userId)
    {
        if (_byUser.TryGetValue((spaceId, userId), out var conns))
        {
            foreach (var e in conns.Values)
            {
                try { e.Close(); } catch { /* connection already gone */ }
            }
        }
        return Task.CompletedTask;
    }

    public void Remove(long spaceId, long userId, Guid connectionId)
    {
        lock (_gate)
        {
            if (!_byUser.TryGetValue((spaceId, userId), out var conns)) return;
            conns.TryRemove(connectionId, out _);
            if (conns.IsEmpty) _byUser.TryRemove((spaceId, userId), out _);
        }
    }

    public bool IsOnline(long spaceId, long userId) => _byUser.ContainsKey((spaceId, userId));

    public async Task BroadcastAsync(long spaceId, byte[] message)
    {
        foreach (var (key, conns) in _byUser)
        {
            if (key.SpaceId != spaceId) continue;
            foreach (var e in conns.Values)
            {
                try { await e.Send(message); } catch { /* a dead connection is reaped by its own pump */ }
            }
        }
    }

    public async Task BroadcastToServerAsync(long spaceId, long serverId, byte[] message)
    {
        foreach (var (key, conns) in _byUser)
            foreach (var e in conns.Values)
            {
                if (key.SpaceId != spaceId || e.ServerId != serverId) continue;
                try { await e.Send(message); } catch { /* reaped by its own pump */ }
            }
    }

    public async Task SendToUserAsync(long spaceId, long userId, byte[] message)
    {
        if (_byUser.TryGetValue((spaceId, userId), out var conns))
        {
            foreach (var e in conns.Values)
            {
                try { await e.Send(message); } catch { /* ignore */ }
            }
        }
    }

    public async Task SendToUserExceptAsync(long spaceId, long userId, Guid exceptConnectionId, byte[] message)
    {
        if (_byUser.TryGetValue((spaceId, userId), out var conns))
        {
            foreach (var (id, e) in conns)
            {
                if (id == exceptConnectionId) continue;
                try { await e.Send(message); } catch { /* ignore */ }
            }
        }
    }
}
