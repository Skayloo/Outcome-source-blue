using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Application.Voice;

public sealed class RefreshVoiceTokenHandler(
    ILiveKitTokenService lk, IVoiceStateRepository voice, IChannelOverrideRepository overrides,
    ICurrentSpace space, IChannelRepository channels, IDmRepository dms, IServerRepository servers)
    : IRequestHandler<RefreshVoiceTokenCommand, VoiceTokenResult?>
{
    public async Task<VoiceTokenResult?> Handle(RefreshVoiceTokenCommand cmd, CancellationToken ct)
    {
        var current = await voice.GetAsync(cmd.UserId, ct);
        if (current is null) return null;
        // The voice_join check again: a row can outlive the access it was granted on (removed from
        // the server, the room deleted), and a refresh is a fresh token — hours more in the call.
        var channel = await channels.GetByIdAsync(current.ChannelId, ct);
        var allowed = channel is { Deleted: false } && (channel.Type == "dm"
            ? await dms.IsParticipantAsync(cmd.UserId, channel.Id, ct)
            : channel.ServerId is { } sid && await servers.IsMemberAsync(sid, cmd.UserId, ct));
        if (!allowed)
        {
            await voice.ClearAsync(cmd.UserId, ct);
            return null;
        }
        var canPublish = await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, current.ChannelId, Perms.SpeakVoice, ct);
        var canVideo = canPublish && await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, current.ChannelId, Perms.UseVideo, ct);
        var canShare = canPublish && await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, current.ChannelId, Perms.ShareScreen, ct);
        var token = lk.GenerateToken(cmd.UserId, cmd.Username, current.ChannelId, canPublish, canVideo, canShare, canSubscribe: true, cmd.SessionId);
        // Same session id as the live join, so a refresh renews THIS participant instead of
        // minting a second identity that would look like another device.
        return new VoiceTokenResult(current.ChannelId, token, lk.Url);
    }
}
