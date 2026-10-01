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

    /// <summary>Drops this user's sessions on OTHER devices from the room, keeping
    /// <paramref name="keepIdentity"/> and every session of its device (identities of the form
    /// user-{id}.{device}.{conn}). The handover when a second device joins; a client re-announcing
    /// voice_join after a reconnect gets a new identity but keeps its own live session.</summary>
    Task RemoveOtherUserSessionsAsync(long channelId, long userId, string keepIdentity, CancellationToken ct = default);

    /// <summary>Is any session of this user still connected to the room?</summary>
    Task<bool> HasUserSessionAsync(long channelId, long userId, CancellationToken ct = default);
    /// <summary>The members (identity "user-*") with a session connected to the room right now.
    /// Unlike voice_states — a row can outlive its call when the server restarts inside the
    /// disconnect grace window — this is who is actually in it. Empty if the room does not exist.</summary>
    Task<IReadOnlySet<long>> ListConnectedUserIdsAsync(long channelId, CancellationToken ct = default);

    /// <summary>Kick every GUEST (identity "guest-*") out of a channel's room — used when a
    /// guest link is revoked, so people already in the call don't just keep talking.</summary>
    Task RemoveGuestsAsync(long channelId, CancellationToken ct = default);

    /// <summary>The guests (identity "guest-*") currently in a channel's room, as
    /// (identity, display name) pairs — used to rebuild guest presence after a restart.</summary>
    Task<IReadOnlyList<(string Identity, string Name)>> ListGuestsAsync(long channelId, CancellationToken ct = default);

    /// <summary>Set a participant attribute on every session of <paramref name="userId"/> in the
    /// room ("" clears it) — what everyone in the call reads, guests included. False when the user
    /// has no session there.</summary>
    Task<bool> SetUserAttributeAsync(long channelId, long userId, string key, string value, CancellationToken ct = default);
}

/// <summary>Verifies and parses LiveKit webhook payloads.</summary>
public interface ILiveKitWebhookReceiver
{
    /// <summary>Returns the parsed event, or null if signature verification fails.</summary>
    WebhookEventInfo? Verify(string body, string authHeader);
}

public sealed record WebhookEventInfo(string Event, string? ParticipantIdentity, string? ParticipantName, string? RoomName);
