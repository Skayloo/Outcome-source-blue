using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Voice;

public sealed class SetVoiceFlagHandler(IVoiceStateRepository voice, IChannelOverrideRepository overrides)
    : IRequestHandler<SetVoiceFlagCommand, VoiceStateDto?>
{
    public async Task<VoiceStateDto?> Handle(SetVoiceFlagCommand cmd, CancellationToken ct)
    {
        var current = await voice.GetAsync(cmd.UserId, ct)
                      ?? throw new DomainException("VOICE_ERROR", 400, "not in a voice channel");

        if (cmd.Flag == VoiceFlag.Camera &&
            !await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, current.ChannelId, Perms.UseVideo, ct))
            throw DomainException.Forbidden("no permission to use video");
        if (cmd.Flag == VoiceFlag.Screenshare &&
            !await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, current.ChannelId, Perms.ShareScreen, ct))
            throw DomainException.Forbidden("no permission to share screen");

        await voice.SetFlagAsync(cmd.UserId, cmd.Flag, cmd.Value, ct);
        return await voice.GetAsync(cmd.UserId, ct);
    }
}
