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
    ICurrentSpace space)
    : IRequestHandler<JoinVoiceCommand, JoinVoiceResult>
{
    public async Task<JoinVoiceResult> Handle(JoinVoiceCommand cmd, CancellationToken ct)
    {
        if (!lk.IsConfigured)
            throw new DomainException("VOICE_ERROR", 400, "voice is not configured on this server");
        if (!await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, cmd.ChannelId, Perms.ConnectVoice, ct))
            throw DomainException.Forbidden("no permission to connect to voice");

        var channel = await channels.GetByIdAsync(cmd.ChannelId, ct) ?? throw DomainException.NotFound("channel not found");

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

        await voice.UpsertJoinAsync(cmd.UserId, cmd.ChannelId, ct);

        var canPublish = await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, cmd.ChannelId, Perms.SpeakVoice, ct);
        var token = lk.GenerateToken(cmd.UserId, cmd.Username, cmd.ChannelId, canPublish, canSubscribe: true, cmd.SessionId);

        // ONE live voice session per account. Every connection joins under its own identity, so
        // this only drops the OTHER devices — and a client re-announcing voice_join after a WS
        // reconnect keeps its media, because its identity is unchanged. The evicted client sees
        // PARTICIPANT_REMOVED and hands over instead of reconnecting.
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
