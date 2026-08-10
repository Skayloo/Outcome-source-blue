namespace Outcome.Shared.Abstractions.Realtime;

/// <summary>
/// The process-wide store of live connections. Every method names the SPACE, because user
/// and server ids are tenant-local: user 5 exists in every space, and delivering one space's
/// frame to another's socket would be a data leak, not a glitch.
///
/// Application code does not use this directly — it injects <see cref="IConnectionRegistry"/>,
/// a scoped view already pinned to the request's space.
/// </summary>
public interface IConnectionHub
{
    void Add(long spaceId, long userId, Guid connectionId, long serverId, Func<byte[], ValueTask> send, Action close);
    void UpdateServer(long spaceId, long userId, Guid connectionId, long serverId);
    void Remove(long spaceId, long userId, Guid connectionId);
    bool IsOnline(long spaceId, long userId);
    /// <summary>Distinct users online, across every space (health reporting only).</summary>
    int Count { get; }

    Task BroadcastAsync(long spaceId, byte[] message);
    Task BroadcastToServerAsync(long spaceId, long serverId, byte[] message);
    Task SendToUserAsync(long spaceId, long userId, byte[] message);
    Task SendToUserExceptAsync(long spaceId, long userId, Guid exceptConnectionId, byte[] message);
    Task CloseUserAsync(long spaceId, long userId);
}

/// <summary>
/// A space-pinned view of <see cref="IConnectionHub"/>: the signatures application code has
/// always used, with the tenant supplied from the scope instead of every call site.
/// </summary>
public sealed class SpaceScopedConnectionRegistry(IConnectionHub hub, long spaceId) : IConnectionRegistry
{
    public int Count => hub.Count;

    public void Add(long userId, Guid connectionId, long serverId, Func<byte[], ValueTask> send, Action close) =>
        hub.Add(spaceId, userId, connectionId, serverId, send, close);

    public void UpdateServer(long userId, Guid connectionId, long serverId) =>
        hub.UpdateServer(spaceId, userId, connectionId, serverId);

    public void Remove(long userId, Guid connectionId) => hub.Remove(spaceId, userId, connectionId);
    public bool IsOnline(long userId) => hub.IsOnline(spaceId, userId);

    public Task BroadcastAsync(byte[] message) => hub.BroadcastAsync(spaceId, message);
    public Task BroadcastToServerAsync(long serverId, byte[] message) => hub.BroadcastToServerAsync(spaceId, serverId, message);
    public Task SendToUserAsync(long userId, byte[] message) => hub.SendToUserAsync(spaceId, userId, message);
    public Task SendToUserExceptAsync(long userId, Guid exceptConnectionId, byte[] message) =>
        hub.SendToUserExceptAsync(spaceId, userId, exceptConnectionId, message);
    public Task CloseUserAsync(long userId) => hub.CloseUserAsync(spaceId, userId);
}
