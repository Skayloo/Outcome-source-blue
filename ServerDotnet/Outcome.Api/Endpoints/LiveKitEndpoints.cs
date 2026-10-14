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

                // To whoever can see this room: its server, and the people in the call (a DM call
                // has no server). These went to every socket in the space — who sat in which room,
                // guests' names, and that two people were on a call with each other.
                async Task ToRoomAsync(byte[] frame)
                {
                    await using var scope = scopeFactory.CreateAsyncScopeFor(space);
                    var channel = await scope.ServiceProvider.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId, ctx.RequestAborted);
                    if (channel?.ServerId is { } sid) await hub.BroadcastToServerAsync(spaceId, sid, frame);
                    foreach (var p in await scope.ServiceProvider.GetRequiredService<IVoiceStateRepository>().GetForChannelAsync(channelId, ctx.RequestAborted))
                        await hub.SendToUserAsync(spaceId, p.UserId, frame);
                }

                switch (evt.Event)
                {
                    case "participant_joined" when isGuest:
                    {
                        // Revoking a link evicts the guests present, but their tokens stay good for six
                        // hours and nothing stopped them walking back in. A guest is let stay only while
                        // the room's current link is the one they came in by.
                        await using (var scope = scopeFactory.CreateAsyncScopeFor(space))
                        {
                            var code = await scope.ServiceProvider.GetRequiredService<IGuestLinkRepository>()
                                .GetActiveCodeForChannelAsync(channelId, ctx.RequestAborted);
                            var rest = identity["guest-".Length..];
                            var current = code is not null && (rest.Length <= 16 || rest.StartsWith(ILiveKitTokenService.GuestLinkTag(code), StringComparison.Ordinal));
                            if (!current)
                            {
                                logger.LogInformation("livekit: removing {Identity} from {Room} — its guest link is gone", identity, evt.RoomName);
                                await scope.ServiceProvider.GetRequiredService<ILiveKitRoomService>().RemoveIdentityAsync(channelId, identity, ctx.RequestAborted);
                                break;
                            }
                        }
                        if (guests.Add(spaceId, channelId, identity, evt.ParticipantName) is { } joinedId)
                            await ToRoomAsync(WsFrames.VoiceState(new VoiceStateDto(
                                channelId, joinedId, evt.ParticipantName ?? "Гость",
                                Muted: false, Deafened: false, Speaking: false, Camera: false, Screenshare: false)));
                        break;
                    }

                    case "participant_left" when isGuest:
                        if (guests.Remove(spaceId, channelId, identity) is { } leftId)
                            await ToRoomAsync(WsFrames.VoiceLeave(channelId, leftId));
                        break;

                    // A member's token is good for a day and outlives the access it was minted for: one
                    // kicked, banned or deleted (or removed from the DM) came back into the room with the
                    // token they kept, and nothing on our side looked. Checked here, on every arrival.
                    case "participant_joined" when TryParseUserId(identity, out var joinedUser):
                    {
                        await using var scope = scopeFactory.CreateAsyncScopeFor(space);
                        var sp = scope.ServiceProvider;
                        var user = await sp.GetRequiredService<IUserRepository>().GetByIdAsync(joinedUser, ctx.RequestAborted);
                        var channel = await sp.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId, ctx.RequestAborted);
                        var allowed = user is { Banned: false, Deleted: false } && channel is { Deleted: false } && (channel.ServerId is { } sid
                            ? await sp.GetRequiredService<IServerRepository>().IsMemberAsync(sid, joinedUser, ctx.RequestAborted)
                            : await sp.GetRequiredService<IDmRepository>().IsParticipantAsync(joinedUser, channelId, ctx.RequestAborted));
                        if (allowed) break;
                        logger.LogInformation("livekit: removing {Identity} from {Room} — no longer allowed in it", identity, evt.RoomName);
                        await sp.GetRequiredService<ILiveKitRoomService>().RemoveIdentityAsync(channelId, identity, ctx.RequestAborted);
                        if (await sp.GetRequiredService<IVoiceStateRepository>().ClearIfInChannelAsync(joinedUser, channelId, ctx.RequestAborted))
                            await ToRoomAsync(WsFrames.VoiceLeave(channelId, joinedUser));
                        break;
                    }

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
                        {
                            // The one who left is no longer a participant: tell them too.
                            var left = WsFrames.VoiceLeave(channelId, userId);
                            await ToRoomAsync(left);
                            await hub.SendToUserAsync(spaceId, userId, left);
                        }
                        break;
                    }

                    case "room_finished":
                        foreach (var gid in guests.Clear(spaceId, channelId))
                            await ToRoomAsync(WsFrames.VoiceLeave(channelId, gid));
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
