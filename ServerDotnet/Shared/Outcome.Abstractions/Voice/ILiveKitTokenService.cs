namespace Outcome.Shared.Abstractions.Voice;

/// <summary>Mints LiveKit access tokens (JWT) via livekit-server-sdk-dotnet.</summary>
public interface ILiveKitTokenService
{
    bool IsConfigured { get; }

    /// <summary>The LiveKit WebSocket URL clients connect to.</summary>
    string Url { get; }

    /// <summary>Token for a user to join the room of <paramref name="channelId"/>
    /// (room "channel-{id}", identity "user-{id}.{sessionId}"). The session suffix is the
    /// WS connection, so one account's devices are DISTINCT participants: LiveKit no longer
    /// evicts one as a duplicate of the other, and handover is decided by us, not by a race.</summary>
    string GenerateToken(long userId, string username, long channelId, bool canPublish, bool canSubscribe, string sessionId);

    /// <summary>The identity a token with these arguments carries — callers evict by it.</summary>
    static string IdentityFor(long userId, string sessionId) => $"user-{userId}.{sessionId}";

    /// <summary>Short-lived AUDIO-ONLY token for an anonymous guest (identity "guest-{nonce}",
    /// the display name they typed). No Outcome session is ever attached to it.</summary>
    string GenerateGuestToken(string displayName, long channelId);

    /// <summary>
    /// A guest token this server issued, verified: still in date, a guest identity, and the room
    /// it admits to. Null for anything else. The only thing a guest holds — they have no account
    /// and no socket — so it is what proves who is writing in the room chat (W3GWG-25 stage 3).
    /// </summary>
    GuestTokenInfo? ReadGuestToken(string jwt);
}

/// <summary>What a verified guest token says: the LiveKit identity, the name the guest typed
/// (with the server's " (guest)" suffix), the room, and when it was issued — the moment the guest
/// joined, from which they may read the room chat.</summary>
public sealed record GuestTokenInfo(string Identity, string Name, string Room, DateTime IssuedAt);
