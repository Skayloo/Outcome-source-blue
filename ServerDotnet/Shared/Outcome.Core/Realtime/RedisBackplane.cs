using System.Buffers.Binary;
using Microsoft.Extensions.Logging;
using Outcome.Shared.Abstractions.Realtime;
using StackExchange.Redis;

namespace Outcome.Realtime;

/// <summary>
/// Multi-replica connection registry: wraps the in-process <see cref="ConnectionRegistry"/>
/// and routes every fan-out operation through a Redis pub/sub channel, so a frame published
/// by any replica is delivered by EVERY replica to its locally-attached sockets. Local
/// bookkeeping (Add/Remove/UpdateServer) stays in-process — only delivery crosses replicas.
///
/// Delivery on the publishing replica also happens via the subscription (Redis delivers to
/// the publisher's own subscriber), which keeps frame ordering identical on all replicas.
/// </summary>
public sealed class RedisBackplaneRegistry : IConnectionHub
{
    // Envelope: [1 byte kind][8 bytes spaceId][8 bytes little-endian id][frame bytes].
    // The space rides on the wire because a replica holds sockets from every tenant: without
    // it, "send to user 5" would hit user 5 of whichever tenants happen to be attached.
    private const byte KindAll = 0;
    private const byte KindServer = 1;
    private const byte KindUser = 2;
    private const byte KindClose = 3;
    private const byte KindUserExcept = 4; // [kind][spaceId 8][userId 8][connGuid 16][frame] — skip one conn

    private static readonly RedisChannel Bus = RedisChannel.Literal("outcome:bus");

    private readonly ConnectionRegistry _local = new();
    private readonly ISubscriber _sub;
    private readonly ILogger<RedisBackplaneRegistry> _logger;

    public RedisBackplaneRegistry(IConnectionMultiplexer redis, ILogger<RedisBackplaneRegistry> logger)
    {
        _logger = logger;
        _sub = redis.GetSubscriber();
        _sub.Subscribe(Bus, (_, value) =>
        {
            try { Deliver((byte[])value!); }
            catch (Exception ex) { _logger.LogWarning(ex, "backplane delivery failed"); }
        });
    }

    /// <summary>Connections attached to THIS replica (health endpoints report per-replica).</summary>
    public int Count => _local.Count;

    public void Add(long spaceId, long userId, Guid connectionId, long serverId, Func<byte[], ValueTask> send, Action close) =>
        _local.Add(spaceId, userId, connectionId, serverId, send, close);

    public void UpdateServer(long spaceId, long userId, Guid connectionId, long serverId) =>
        _local.UpdateServer(spaceId, userId, connectionId, serverId);

    public void Remove(long spaceId, long userId, Guid connectionId) => _local.Remove(spaceId, userId, connectionId);

    /// <summary>Local-replica check only. Presence may briefly flicker for a user who holds
    /// sockets on two replicas at once — acceptable for the offline-broadcast heuristic.</summary>
    public bool IsOnline(long spaceId, long userId) => _local.IsOnline(spaceId, userId);

    public Task BroadcastAsync(long spaceId, byte[] message) => PublishAsync(KindAll, spaceId, 0, message);

    public Task BroadcastToServerAsync(long spaceId, long serverId, byte[] message) => PublishAsync(KindServer, spaceId, serverId, message);

    public Task SendToUserAsync(long spaceId, long userId, byte[] message) => PublishAsync(KindUser, spaceId, userId, message);

    public Task SendToUserExceptAsync(long spaceId, long userId, Guid exceptConnectionId, byte[] message)
    {
        // Connection ids are replica-local: only the ORIGIN replica can match (and skip) the
        // excluded conn; on every other replica the guid matches nothing, so the user's
        // connections there all receive the frame — which is exactly right.
        var payload = new byte[1 + 8 + 8 + 16 + message.Length];
        payload[0] = KindUserExcept;
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(1, 8), spaceId);
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(9, 8), userId);
        exceptConnectionId.TryWriteBytes(payload.AsSpan(17, 16));
        message.CopyTo(payload, 33);
        return PublishRawAsync(payload);
    }

    public Task CloseUserAsync(long spaceId, long userId) => PublishAsync(KindClose, spaceId, userId, []);

    private Task PublishAsync(byte kind, long spaceId, long id, byte[] frame)
    {
        var payload = new byte[1 + 8 + 8 + frame.Length];
        payload[0] = kind;
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(1, 8), spaceId);
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(9, 8), id);
        frame.CopyTo(payload, 17);
        return PublishRawAsync(payload);
    }

    private async Task PublishRawAsync(byte[] payload)
    {
        try
        {
            await _sub.PublishAsync(Bus, payload);
        }
        catch (Exception ex)
        {
            // Redis hiccup: fall back to local-only delivery so THIS replica's users still get it.
            _logger.LogWarning(ex, "backplane publish failed — delivering locally only");
            Deliver(payload);
        }
    }

    private void Deliver(byte[] payload)
    {
        var kind = payload[0];
        var spaceId = BinaryPrimitives.ReadInt64LittleEndian(payload.AsSpan(1, 8));
        var id = BinaryPrimitives.ReadInt64LittleEndian(payload.AsSpan(9, 8));
        if (kind == KindUserExcept)
        {
            var except = new Guid(payload.AsSpan(17, 16));
            _ = _local.SendToUserExceptAsync(spaceId, id, except, payload[33..]);
            return;
        }
        var frame = payload[17..];
        _ = kind switch
        {
            KindAll => _local.BroadcastAsync(spaceId, frame),
            KindServer => _local.BroadcastToServerAsync(spaceId, id, frame),
            KindUser => _local.SendToUserAsync(spaceId, id, frame),
            KindClose => _local.CloseUserAsync(spaceId, id),
            _ => Task.CompletedTask,
        };
    }
}

/// <summary>
/// Multi-replica offline-call parking: the caller may ring from replica A while the callee's
/// socket later lands on replica B, so the parked call must be visible to every replica.
/// One key per callee with a TTL equal to the ring window; the value carries the full
/// <see cref="PendingCall"/> so any replica can deliver it verbatim.
/// </summary>
public sealed class RedisPendingCallStore(IConnectionMultiplexer redis) : IPendingCallStore
{
    private readonly IDatabase _db = redis.GetDatabase();

    private static string Key(long spaceId, long calleeId) => $"outcome:s{spaceId}:pendingcall:{calleeId}";

    public void Park(long spaceId, long calleeId, PendingCall call)
    {
        var ttl = call.ExpiresAt - DateTimeOffset.UtcNow;
        if (ttl <= TimeSpan.Zero) return; // already expired — nothing to park
        // Overwrite semantics on purpose: a callee has at most one pending call, last caller wins.
        _db.StringSet(Key(spaceId, calleeId), System.Text.Json.JsonSerializer.Serialize(call), ttl);
    }

    public bool TryTake(long spaceId, long calleeId, out PendingCall call)
    {
        // GETDEL — atomic, so two replicas racing on the same callee deliver the call once.
        var raw = _db.StringGetDelete(Key(spaceId, calleeId));
        if (!raw.IsNullOrEmpty)
        {
            var parked = System.Text.Json.JsonSerializer.Deserialize<PendingCall>((string)raw!);
            if (parked is not null && parked.ExpiresAt > DateTimeOffset.UtcNow)
            {
                call = parked;
                return true;
            }
        }
        call = default!;
        return false;
    }

    public void Clear(long spaceId, long calleeId, long callerId)
    {
        // Same compare-and-remove contract as the in-memory store: delete only the exact value
        // we just read (guarded by a value-equality condition), so a stale cancel can't wipe a
        // newer call that replaced it in the meantime.
        var key = Key(spaceId, calleeId);
        var raw = _db.StringGet(key);
        if (raw.IsNullOrEmpty) return;
        var parked = System.Text.Json.JsonSerializer.Deserialize<PendingCall>((string)raw!);
        if (parked is null || parked.CallerId != callerId) return;
        var tran = _db.CreateTransaction();
        tran.AddCondition(Condition.StringEqual(key, raw));
        _ = tran.KeyDeleteAsync(key);
        tran.Execute();
    }
}

/// <summary>
/// Multi-replica replay buffer: a globally monotonic sequence via Redis INCR and one bounded
/// Redis list of recent frames per server, so a client can reconnect to ANY replica and
/// replay exactly what it missed. Entries are "<c>seq:base64(frame)</c>" strings.
/// </summary>
public sealed class RedisReplayBuffer(IConnectionMultiplexer redis) : IMessageReplayBuffer
{
    private const int Capacity = 500;
    private readonly IDatabase _db = redis.GetDatabase();

    private static string Key(long spaceId, long serverId) => $"outcome:s{spaceId}:replay:{serverId}";

    public long Next(long spaceId) => _db.StringIncrement($"outcome:s{spaceId}:seq");

    public void Record(long spaceId, long seq, long serverId, byte[] frame)
    {
        var key = Key(spaceId, serverId);
        _db.ListRightPush(key, $"{seq}:{Convert.ToBase64String(frame)}");
        _db.ListTrim(key, -Capacity, -1);
        _db.KeyExpire(key, TimeSpan.FromHours(24));
    }

    public IReadOnlyList<byte[]> Since(long spaceId, long lastSeq, long serverId)
    {
        var entries = _db.ListRange(Key(spaceId, serverId));
        var result = new List<byte[]>();
        foreach (var entry in entries)
        {
            var s = (string?)entry;
            if (s is null) continue;
            var sep = s.IndexOf(':');
            if (sep <= 0 || !long.TryParse(s.AsSpan(0, sep), out var seq) || seq <= lastSeq) continue;
            try { result.Add(Convert.FromBase64String(s[(sep + 1)..])); }
            catch (FormatException) { /* corrupt entry — skip */ }
        }
        return result; // list is push-ordered by seq already
    }
}
