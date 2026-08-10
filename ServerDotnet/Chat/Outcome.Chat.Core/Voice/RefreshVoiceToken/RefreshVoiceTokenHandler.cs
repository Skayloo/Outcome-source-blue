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
    ICurrentSpace space)
    : IRequestHandler<RefreshVoiceTokenCommand, VoiceTokenResult?>
{
    public async Task<VoiceTokenResult?> Handle(RefreshVoiceTokenCommand cmd, CancellationToken ct)
    {
        var current = await voice.GetAsync(cmd.UserId, ct);
        if (current is null) return null;
        var canPublish = await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, current.ChannelId, Perms.SpeakVoice, ct);
        var token = lk.GenerateToken(cmd.UserId, cmd.Username, current.ChannelId, canPublish, canSubscribe: true, cmd.SessionId);
        // Same session id as the live join, so a refresh renews THIS participant instead of
        // minting a second identity that would look like another device.
        return new VoiceTokenResult(current.ChannelId, token, lk.Url);
    }
}
