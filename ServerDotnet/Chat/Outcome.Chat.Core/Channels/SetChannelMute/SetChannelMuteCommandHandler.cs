using MediatR;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Channels;

public sealed class SetChannelMuteHandler(
    IChannelRepository channels, IDmRepository dms, IChannelMuteRepository mutes)
    : IRequestHandler<SetChannelMuteCommand>
{
    public async Task Handle(SetChannelMuteCommand cmd, CancellationToken ct)
    {
        var channel = await channels.GetByIdAsync(cmd.ChannelId, ct) ?? throw DomainException.NotFound("channel not found");
        // DMs: only a participant can mute their side. Server channels need no permission —
        // the flag is a personal notification preference, invisible to everyone else.
        if (channel.Type == "dm" && !await dms.IsParticipantAsync(cmd.UserId, cmd.ChannelId, ct))
            throw DomainException.Forbidden("you are not a participant in this DM");

        await mutes.SetAsync(cmd.UserId, cmd.ChannelId, cmd.Muted, ct);
    }
}
