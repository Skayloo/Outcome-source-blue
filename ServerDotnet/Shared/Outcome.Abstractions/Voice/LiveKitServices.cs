namespace Outcome.Shared.Abstractions.Voice;

/// <summary>
/// LiveKit room naming. The space is part of the name because channel ids are tenant-local:
/// channel 5 of two spaces must not be the same call. It also carries the tenant back to us
/// on the webhook path, which has no Host to resolve from.
/// </summary>
public static class LiveKitRooms
{
    public static string Name(long spaceId, long channelId) => $"s{spaceId}-channel-{channelId}";

    public static bool TryParse(string? room, out long spaceId, out long channelId)
    {
        spaceId = 0; channelId = 0;
        if (string.IsNullOrEmpty(room)) return false;
        var dash = room.IndexOf("-channel-", StringComparison.Ordinal);
        if (dash <= 1 || room[0] != 's') return false;
        return long.TryParse(room.AsSpan(1, dash - 1), out spaceId)
               && long.TryParse(room.AsSpan(dash + 9), out channelId);
    }
}

/// <summary>Server-side LiveKit room operations (RoomServiceClient).</summary>
public interface ILiveKitRoomService
{
    Task<bool> IsHealthyAsync(CancellationToken ct = default);

    /// <summary>Force-disconnects EVERY session of a user from a channel's room (ban/kick).</summary>
    Task RemoveParticipantAsync(long channelId, long userId, CancellationToken ct = default);

    /// <summary>Drops this user's OTHER sessions from the room, keeping <paramref name="keepIdentity"/>.
    /// The handover when a second device joins — deterministic, and a lone client re-announcing
    /// voice_join keeps its own live session because the identity is stable per connection.</summary>
    Task RemoveOtherUserSessionsAsync(long channelId, long userId, string keepIdentity, CancellationToken ct = default);

    /// <summary>Is any session of this user still connected to the room?</summary>
    Task<bool> HasUserSessionAsync(long channelId, long userId, CancellationToken ct = default);

    /// <summary>Kick every GUEST (identity "guest-*") out of a channel's room — used when a
    /// guest link is revoked, so people already in the call don't just keep talking.</summary>
    Task RemoveGuestsAsync(long channelId, CancellationToken ct = default);

    /// <summary>The guests (identity "guest-*") currently in a channel's room, as
    /// (identity, display name) pairs — used to rebuild guest presence after a restart.</summary>
    Task<IReadOnlyList<(string Identity, string Name)>> ListGuestsAsync(long channelId, CancellationToken ct = default);
}

/// <summary>Verifies and parses LiveKit webhook payloads.</summary>
public interface ILiveKitWebhookReceiver
{
    /// <summary>Returns the parsed event, or null if signature verification fails.</summary>
    WebhookEventInfo? Verify(string body, string authHeader);
}

public sealed record WebhookEventInfo(string Event, string? ParticipantIdentity, string? ParticipantName, string? RoomName);
