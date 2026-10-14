using System.Collections.Concurrent;

namespace Outcome.Api.Realtime;

/// <summary>
/// "One of this user's sessions was just revoked — check yours now." Logout, revoking a session,
/// "sign out everywhere else", a password change or reset bump the user's generation; each of
/// their sockets notices within <see cref="WebSocketHandler"/>'s short poll and re-checks ITS OWN
/// session, so only the revoked device is thrown out — closing all of the user's sockets would
/// also cut the device that did the revoking (and its call) for a reconnect.
///
/// Per replica: a revocation on replica A wakes the sockets on A only. Sockets elsewhere fall back
/// to the periodic re-check (one minute). Production runs one replica.
/// </summary>
public sealed class SessionRevocations
{
    private readonly ConcurrentDictionary<(long Space, long User), long> _generation = new();

    public void Revoked(long spaceId, long userId) =>
        _generation.AddOrUpdate((spaceId, userId), 1, (_, g) => g + 1);

    public long Generation(long spaceId, long userId) =>
        _generation.TryGetValue((spaceId, userId), out var g) ? g : 0;
}
