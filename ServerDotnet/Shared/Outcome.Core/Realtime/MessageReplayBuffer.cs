using System.Collections.Concurrent;
using Outcome.Shared.Abstractions.Realtime;

namespace Outcome.Realtime;

/// <summary>In-memory bounded replay buffer. Recent broadcast frames only (DM frames are
/// participant-scoped and not recorded).</summary>
public sealed class MessageReplayBuffer : IMessageReplayBuffer
{
    private const int Capacity = 500;

    private long _seq;
    private readonly ConcurrentQueue<(long SpaceId, long Seq, long ServerId, byte[] Frame)> _buffer = new();

    // One counter for the process is fine: sequence numbers only ever have to be
    // monotonic per client, and Since() filters by space anyway.
    public long Next(long spaceId) => Interlocked.Increment(ref _seq);

    public void Record(long spaceId, long seq, long serverId, byte[] frame)
    {
        _buffer.Enqueue((spaceId, seq, serverId, frame));
        while (_buffer.Count > Capacity && _buffer.TryDequeue(out _)) { }
    }

    public IReadOnlyList<byte[]> Since(long spaceId, long lastSeq, long serverId) =>
        _buffer.Where(x => x.SpaceId == spaceId && x.Seq > lastSeq && x.ServerId == serverId).OrderBy(x => x.Seq).Select(x => x.Frame).ToList();
}
