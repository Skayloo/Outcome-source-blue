using System.Collections.Concurrent;
using Outcome.Shared.Abstractions.Realtime;

namespace Outcome.Realtime;

/// <inheritdoc cref="IPendingCallStore"/>
public sealed class PendingCallStore : IPendingCallStore
{
    // calleeId -> the one call currently ringing them while offline. A callee has at most one
    // pending call; a fresh offer overwrites an older one (last caller wins, like a real phone).
    private readonly ConcurrentDictionary<(long SpaceId, long CalleeId), PendingCall> _pending = new();

    public void Park(long spaceId, long calleeId, PendingCall call) => _pending[(spaceId, calleeId)] = call;

    public bool TryTake(long spaceId, long calleeId, out PendingCall call)
    {
        if (_pending.TryRemove((spaceId, calleeId), out var c) && c.ExpiresAt > DateTimeOffset.UtcNow)
        {
            call = c;
            return true;
        }
        call = default!;
        return false;
    }

    public void Clear(long spaceId, long calleeId, long callerId)
    {
        // Compare-and-remove on the exact record (PendingCall is a value type by record equality),
        // so a cancel can't wipe a newer call that replaced this one in the meantime.
        if (_pending.TryGetValue((spaceId, calleeId), out var c) && c.CallerId == callerId)
            _pending.TryRemove(new KeyValuePair<(long, long), PendingCall>((spaceId, calleeId), c));
    }
}
