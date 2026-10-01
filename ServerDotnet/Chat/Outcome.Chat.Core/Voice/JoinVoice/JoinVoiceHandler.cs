using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Application.Voice;

public sealed class JoinVoiceHandler(
    ILiveKitTokenService lk, IVoiceStateRepository voice, IChannelRepository channels,
    IChannelOverrideRepository overrides, ILiveKitRoomService rooms,
    ICurrentSpace space, IDmRepository dms, IServerRepository servers)
    : IRequestHandler<JoinVoiceCommand, JoinVoiceResult>
{
    public async Task<JoinVoiceResult> Handle(JoinVoiceCommand cmd, CancellationToken ct)
    {
        if (!lk.IsConfigured)
            throw new DomainException("VOICE_ERROR", 400, "voice is not configured on this server");
        if (!await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, cmd.ChannelId, Perms.ConnectVoice, ct))
            throw DomainException.Forbidden("no permission to connect to voice");

        var channel = await channels.GetByIdAsync(cmd.ChannelId, ct) ?? throw DomainException.NotFound("channel not found");
        if (channel.Deleted) throw DomainException.NotFound("channel not found");

        // Being in the space is not enough. This is the only gate in front of a LiveKit token, and
        // joining writes the voice_states row the room-key relay trusts — so an unchecked id let
        // anyone in the space sit in any server's room, or in somebody else's DM call, and be
        // handed its key by the people in it. Membership of the channel's OWN server, not the
        // active one: voice survives switch_server, and the re-join after a reconnect names it.
        if (channel.Type == "dm")
        {
            if (!await dms.IsParticipantAsync(cmd.UserId, channel.Id, ct))
                throw DomainException.Forbidden("you are not in this call");
        }
        else if (channel.Type != "voice" || channel.ServerId is not { } sid
                 || !await servers.IsMemberAsync(sid, cmd.UserId, ct))
        {
            throw DomainException.Forbidden("no access to this voice channel");
        }

        var current = await voice.GetAsync(cmd.UserId, ct);
        long? previous = null;
        // Already in THIS channel → treat as a RE-JOIN, not an error. A client re-announces
        // voice_join after any WS reconnect (mobile churn, a reopened tab within the disconnect
        // grace window), and rejecting it with ALREADY_JOINED left the user stranded: presence
        // said they were in voice, but they never got a fresh token and so never reconnected
        // to LiveKit. Re-issuing the token is idempotent and heals exactly that.
        var isRejoin = current is not null && current.ChannelId == cmd.ChannelId;
        if (current is not null && !isRejoin)
        {
            previous = current.ChannelId;
            await voice.ClearAsync(cmd.UserId, ct);
        }

        // The full check only applies to a genuinely NEW joiner — a re-join is already counted.
        if (!isRejoin && channel.VoiceMaxUsers > 0
            && await voice.CountForChannelAsync(cmd.ChannelId, ct) >= channel.VoiceMaxUsers)
            throw new DomainException("CHANNEL_FULL", 400, "voice channel is full");

        // A re-announce of the call the client is still in keeps its flags: resetting them showed a
        // muted phone as live to everyone after every socket blip, while it went on sending nothing.
        await voice.UpsertJoinAsync(cmd.UserId, cmd.ChannelId, keepFlags: isRejoin && cmd.Rejoin, ct);

        var canPublish = await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, cmd.ChannelId, Perms.SpeakVoice, ct);
        var token = lk.GenerateToken(cmd.UserId, cmd.Username, cmd.ChannelId, canPublish, canSubscribe: true, cmd.SessionId);

        // ONE live voice session per account: this drops the account's sessions on OTHER devices.
        // Every connection joins under its own identity, and a client that names its device
        // (user-{id}.{device}.{conn}) keeps every session of that device — so the re-join it sends
        // after a WS reconnect no longer throws out the media session it is still using. (A client
        // that names no device still loses it: its identity changed with the connection.) The
        // evicted client sees PARTICIPANT_REMOVED and hands over instead of reconnecting.
        await rooms.RemoveOtherUserSessionsAsync(
            cmd.ChannelId, cmd.UserId, ILiveKitTokenService.IdentityFor(cmd.UserId, cmd.SessionId), ct);

        var joiner = await voice.GetAsync(cmd.UserId, ct)
                     ?? throw new DomainException("VOICE_ERROR", 500, "failed to join voice channel");
        var existing = (await voice.GetForChannelAsync(cmd.ChannelId, ct)).Where(v => v.UserId != cmd.UserId).ToList();
        var quality = channel.VoiceQuality is { Length: > 0 } q && VoiceQuality.IsValid(q) ? q : "medium";

        // A guest-linked channel admits anonymous guests who can't do the WS key exchange, so its
        // members use a shared room key derived from the link code instead — the same key the guest
        // gets — keeping everyone mutually audible AND encrypted. Null → ordinary WS key exchange.
        return new JoinVoiceResult(token, lk.Url, quality, VoiceQuality.Bitrate(quality), channel.VoiceMaxUsers, joiner, existing, previous);
    }
}
