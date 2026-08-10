using System.Collections.Concurrent;

namespace Outcome.Api.Realtime;

/// <summary>
/// In-memory registry of GUESTS currently sitting in voice rooms, fed by LiveKit webhooks
/// (participant_joined / participant_left / room_finished) and a startup sweep.
///
/// Guests join LiveKit directly and never touch the Outcome WS, so the server's voice_states
/// table knows nothing about them. Members IN the room mirror guests from their own LiveKit
/// connection, but everyone else — a member just browsing the sidebar — had no way to learn a
/// guest exists. This registry is that missing source of truth: the webhook feed keeps it live,
/// READY snapshots include it, and joins/leaves are broadcast like any other voice_state.
/// </summary>
public sealed class GuestPresence
{
    private sealed record Guest(long Id, string Name);

    /// <summary>channelId → (identity → guest). Identity is the dedupe key; the derived negative
    /// id is what clients key their rosters by.</summary>
    private readonly ConcurrentDictionary<(long SpaceId, long ChannelId), ConcurrentDictionary<string, Guest>> _byChannel = new();

    /// <summary>A guest identity ("guest-&lt;hex nonce&gt;") → the SAME stable negative id the web
    /// client derives in parseUserId (32-bit signed h*31+c over the nonce, then -(|h| or 1)), so a
    /// server-broadcast guest and a client-mirrored one collapse into one roster row.</summary>
    public static long IdFor(string identity)
    {
        var nonce = identity.StartsWith("guest-", StringComparison.Ordinal)
            ? identity["guest-".Length..] : identity;
        var h = 0;
        foreach (var c in nonce) h = unchecked(h * 31 + c);
        var abs = Math.Abs((long)h);
        return -(abs == 0 ? 1 : abs);
    }

    /// <summary>Record a guest as present. Returns their negative id, or null when this exact
    /// identity was already known (duplicate webhook — nothing to broadcast).</summary>
    public long? Add(long spaceId, long channelId, string identity, string? name)
    {
        var id = IdFor(identity);
        var guests = _byChannel.GetOrAdd((spaceId, channelId), _ => new ConcurrentDictionary<string, Guest>());
        return guests.TryAdd(identity, new Guest(id, string.IsNullOrEmpty(name) ? "Гость" : name)) ? id : null;
    }

    /// <summary>Remove a guest. Returns their negative id, or null if they weren't tracked.</summary>
    public long? Remove(long spaceId, long channelId, string identity)
    {
        if (!_byChannel.TryGetValue((spaceId, channelId), out var guests)) return null;
        var removed = guests.TryRemove(identity, out var g) ? g.Id : (long?)null;
        if (guests.IsEmpty) _byChannel.TryRemove((spaceId, channelId), out _);
        return removed;
    }

    /// <summary>Drop every guest of a channel (room_finished / link revoked), returning their ids.</summary>
    public IReadOnlyList<long> Clear(long spaceId, long channelId) =>
        _byChannel.TryRemove((spaceId, channelId), out var guests)
            ? guests.Values.Select(g => g.Id).ToList()
            : [];

    /// <summary>Current guests of a channel as (negative id, display name) rows for READY.</summary>
    public IReadOnlyList<(long Id, string Name)> Snapshot(long spaceId, long channelId) =>
        _byChannel.TryGetValue((spaceId, channelId), out var guests)
            ? guests.Values.Select(g => (g.Id, g.Name)).ToList()
            : [];
}
