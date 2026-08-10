using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Channels;

public sealed class SetPinHandler(
    IChannelRepository channels, IChannelOverrideRepository overrides, IMessageRepository messages, IDmRepository dms, ICurrentServer server)
    : IRequestHandler<SetPinCommand>
{
    public async Task Handle(SetPinCommand cmd, CancellationToken ct)
    {
        var channel = await channels.GetByIdAsync(cmd.ChannelId, ct) ?? throw DomainException.NotFound("channel not found");
        if (channel.Type == "dm")
        {
            // DMs: only participants may pin/unpin (mirrors GetChannelMessagesHandler).
            if (!await dms.IsParticipantAsync(cmd.UserId, cmd.ChannelId, ct))
                throw DomainException.Forbidden("you are not a participant in this DM");
        }
        else
        {
            if (channel.ServerId is { } sid && sid != server.ServerId)
                throw DomainException.Forbidden("channel is not in your active server");
            if (!await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, cmd.ChannelId, Perms.ManageMessages, ct))
                throw DomainException.Forbidden("no permission to manage pins");
        }

        if (!await messages.SetPinnedAsync(cmd.ChannelId, cmd.MessageId, cmd.Pinned, ct))
            throw DomainException.NotFound("message not found");
    }
}
