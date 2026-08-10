using Outcome.Api.Realtime;
using Outcome.Application.Voice;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Endpoints;

public static class LiveKitEndpoints
{
    public static void MapLiveKitEndpoints(this IEndpointRouteBuilder app)
    {
        // LiveKit webhook (verified by the SDK's HMAC token check). Two jobs: clean up stale MEMBER
        // voice state, and track GUEST presence — guests live only in LiveKit, so these events are
        // the sole way anyone NOT in the room (a member browsing the sidebar) learns about them.
        app.MapPost("/api/v1/livekit/webhook",
            async (HttpContext ctx, ILiveKitWebhookReceiver receiver, IConnectionHub hub,
                   GuestPresence guests, IServiceScopeFactory scopeFactory,
                   ISpaceRegistry spaces, ILogger<GuestPresence> logger) =>
            {
                using var reader = new StreamReader(ctx.Request.Body);
                var body = await reader.ReadToEndAsync(ctx.RequestAborted);

                var evt = receiver.Verify(body, ctx.Request.Headers.Authorization.ToString());
                if (evt is null)
                {
                    // Key mismatch or malformed payload — without this line a misconfigured
                    // webhook fails in total silence and guests just never show up.
                    logger.LogWarning("livekit webhook rejected: signature verification failed (body {Bytes}b)", body.Length);
                    return Results.Unauthorized();
                }
                logger.LogDebug("livekit webhook: {Event} {Identity} {Room}", evt.Event, evt.ParticipantIdentity, evt.RoomName);

                // LiveKit calls us on an internal address, so there is no Host to resolve the
                // tenant from — the room name carries it (see LiveKitRooms).
                if (!LiveKitRooms.TryParse(evt.RoomName, out var spaceId, out var channelId)) return Results.Ok();
                var space = await spaces.ByIdAsync(spaceId, ctx.RequestAborted);
                if (space is null) return Results.Ok();

                var identity = evt.ParticipantIdentity ?? "";
                var isGuest = identity.StartsWith("guest-", StringComparison.Ordinal);

                switch (evt.Event)
                {
                    case "participant_joined" when isGuest:
                        if (guests.Add(spaceId, channelId, identity, evt.ParticipantName) is { } joinedId)
                            await hub.BroadcastAsync(spaceId, WsFrames.VoiceState(new VoiceStateDto(
                                channelId, joinedId, evt.ParticipantName ?? "Гость",
                                Muted: false, Deafened: false, Speaking: false, Camera: false, Screenshare: false)));
                        break;

                    case "participant_left" when isGuest:
                        if (guests.Remove(spaceId, channelId, identity) is { } leftId)
                            await hub.BroadcastAsync(spaceId, WsFrames.VoiceLeave(channelId, leftId));
                        break;

                    // Identity is "user-{id}" or "user-{id}.{session}" — one device of the account.
                    case "participant_left" when TryParseUserId(identity, out var userId):
                    {
                        // A handover leaves the OLD session while the new one is already in the
                        // room: clearing presence then would drop a user who is still in the call.
                        await using var scope = scopeFactory.CreateAsyncScopeFor(space);
                        var rooms = scope.ServiceProvider.GetRequiredService<ILiveKitRoomService>();
                        if (await rooms.HasUserSessionAsync(channelId, userId, ctx.RequestAborted)) break;
                        var voice = scope.ServiceProvider.GetRequiredService<IVoiceStateRepository>();
                        if (await voice.ClearIfInChannelAsync(userId, channelId, ctx.RequestAborted))
                            await hub.BroadcastAsync(spaceId, WsFrames.VoiceLeave(channelId, userId));
                        break;
                    }

                    case "room_finished":
                        foreach (var gid in guests.Clear(spaceId, channelId))
                            await hub.BroadcastAsync(spaceId, WsFrames.VoiceLeave(channelId, gid));
                        break;
                }

                return Results.Ok();
            });

        // LiveKit connectivity check via RoomServiceClient.ListRooms.
        app.MapGet("/api/v1/livekit/health", async (ILiveKitRoomService room) =>
            await room.IsHealthyAsync()
                ? Results.Json(new { ok = true })
                : Results.Json(new { ok = false }, statusCode: StatusCodes.Status503ServiceUnavailable));
    }

    /// <summary>"user-{id}" or "user-{id}.{session}" → the user id. One account may hold
    /// several sessions in a room during a handover, and they all carry the same id.</summary>
    private static bool TryParseUserId(string? identity, out long id)
    {
        id = 0;
        if (identity is null || !identity.StartsWith("user-", StringComparison.Ordinal)) return false;
        var rest = identity.AsSpan(5);
        var dot = rest.IndexOf('.');
        return long.TryParse(dot >= 0 ? rest[..dot] : rest, out id);
    }

    private static bool TryParseSuffix(string? value, string prefix, out long id)
    {
        id = 0;
        return value is not null && value.StartsWith(prefix, StringComparison.Ordinal)
            && long.TryParse(value.AsSpan(prefix.Length), out id);
    }
}
