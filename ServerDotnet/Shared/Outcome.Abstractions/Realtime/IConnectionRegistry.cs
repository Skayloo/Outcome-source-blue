namespace Outcome.Shared.Abstractions.Realtime;

/// <summary>
/// Registry of live WebSocket connections (single connection per user). Fan-out helpers
/// enqueue raw JSON frames onto each connection's send pump. Implemented in Outcome.Realtime.
/// </summary>
public interface IConnectionRegistry
{
    int Count { get; }

    /// <summary>Registers (or replaces) the connection for a user, tagged with the tenant
    /// (<paramref name="serverId"/>) the connection is currently viewing. <paramref name="close"/> force-closes it.</summary>
    void Add(long userId, Guid connectionId, long serverId, Func<byte[], ValueTask> send, Action close);

    /// <summary>Re-tags a live connection with the tenant it is now viewing, WITHOUT dropping it.
    /// Used when a user switches active server over the existing socket so voice/presence survive.</summary>
    void UpdateServer(long userId, Guid connectionId, long serverId);

    /// <summary>Removes the connection only if it is still the current one for the user.</summary>
    void Remove(long userId, Guid connectionId);

    /// <summary>Fan-out to EVERY connection (use only for instance-wide events like server_restart).</summary>
    Task BroadcastAsync(byte[] message);

    /// <summary>Fan-out only to connections currently viewing <paramref name="serverId"/> — the tenant
    /// boundary for chat/channel/member/typing/presence frames.</summary>
    Task BroadcastToServerAsync(long serverId, byte[] message);

    Task SendToUserAsync(long userId, byte[] message);

    /// <summary>All of a user's connections EXCEPT one — e.g. telling the OTHER devices a
    /// newer connection took the voice session over.</summary>
    Task SendToUserExceptAsync(long userId, Guid exceptConnectionId, byte[] message);

    /// <summary>Force-closes a user's live connection (used by kick/ban).</summary>
    Task CloseUserAsync(long userId);

    bool IsOnline(long userId);
}
