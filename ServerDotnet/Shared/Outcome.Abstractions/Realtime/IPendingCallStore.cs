namespace Outcome.Shared.Abstractions.Realtime;

/// <summary>A call that rang a user while they were offline, held briefly so it can pop the moment
/// they connect (within the ring window) instead of being dropped with an "offline" reject.</summary>
public sealed record PendingCall(long CallerId, string CallerName, string? CallerAvatar, long ChannelId, DateTimeOffset ExpiresAt);

/// <summary>
/// Short-lived store of calls placed to an offline user. A caller may ring someone who is not
/// connected; the offer is parked here (TTL ≈ the caller's ring window) and delivered when the
/// callee's socket comes online. Two implementations: in-process (single node) and Redis-backed
/// (the callee may connect to a DIFFERENT replica than the one the caller rang from). Mobile
/// push (FCM/APNs) for waking a fully-closed app remains the missing offline path.
/// </summary>
public interface IPendingCallStore
{
    /// <summary>Park a call for a callee who is currently offline (overwrites any older pending call).</summary>
    void Park(long spaceId, long calleeId, PendingCall call);

    /// <summary>Atomically remove and return the callee's pending call, if one exists and hasn't expired.</summary>
    bool TryTake(long spaceId, long calleeId, out PendingCall call);

    /// <summary>Drop the pending call for a callee only if it was placed by <paramref name="callerId"/>,
    /// so the original caller's cancel clears it but a stale cancel can't wipe a newer call.</summary>
    void Clear(long spaceId, long calleeId, long callerId);
}
