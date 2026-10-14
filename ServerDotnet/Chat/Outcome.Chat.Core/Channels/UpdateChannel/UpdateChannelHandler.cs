using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Channels;

public sealed class UpdateChannelHandler(IChannelRepository channels, ICurrentServer server) : IRequestHandler<UpdateChannelCommand, ChannelDto>
{
    public async Task<ChannelDto> Handle(UpdateChannelCommand cmd, CancellationToken ct)
    {
        ChannelAdminAuth.Require(cmd.Permissions);
        var existing = await channels.GetByIdAsync(cmd.Id, ct) ?? throw DomainException.NotFound("channel not found");
        // Exactly the active server — a DM has no server, and the old `ServerId is { } sid && sid !=`
        // let every DM through: anyone who made a server of their own (and so held ManageChannels in
        // it) could rename or archive somebody else's conversation by its id.
        if (existing.ServerId != server.ServerId)
            throw DomainException.Forbidden("channel is not in your active server");
        var name = cmd.Name is null ? null : TextSanitizer.StripHtml(cmd.Name);
        var topic = cmd.Topic is null ? null : TextSanitizer.StripHtml(cmd.Topic);

        if (!await channels.UpdateAsync(cmd.Id, name, topic, cmd.SlowMode, cmd.Position, cmd.Archived, ct))
            throw DomainException.NotFound("channel not found");
        // A voice room and its chat keep one name.
        if (name is not null && existing.ChatChannelId is { } chat)
            await channels.UpdateAsync(chat, name, null, null, null, null, ct);

        var updated = await channels.GetByIdAsync(cmd.Id, ct) ?? throw DomainException.NotFound("channel not found");
        return ChannelMapper.ToDto(updated);
    }
}
