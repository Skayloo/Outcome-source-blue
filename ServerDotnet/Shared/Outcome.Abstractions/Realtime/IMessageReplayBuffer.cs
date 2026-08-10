namespace Outcome.Shared.Abstractions.Realtime;

/// <summary>
/// Assigns a monotonic sequence number to broadcast channel events and keeps a bounded ring
/// buffer of recent frames so a reconnecting client can replay what it missed (honoring the
/// client's last_seq reconnect protocol).
/// </summary>
public interface IMessageReplayBuffer
{
    /// <summary>Next monotonic sequence number.</summary>
    long Next(long spaceId);

    /// <summary>Records a broadcast frame (already stamped with <paramref name="seq"/>) for replay,
    /// tagged with the tenant (<paramref name="serverId"/>) it was broadcast to.</summary>
    void Record(long spaceId, long seq, long serverId, byte[] frame);

    /// <summary>Buffered frames with seq greater than <paramref name="lastSeq"/> that belong to
    /// <paramref name="serverId"/>, in order. Tenant-scoped so replay can never leak another
    /// server's traffic.</summary>
    IReadOnlyList<byte[]> Since(long spaceId, long lastSeq, long serverId);
}
