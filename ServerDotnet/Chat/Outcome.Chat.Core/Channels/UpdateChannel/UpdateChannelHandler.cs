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
        if (existing.ServerId is { } sid && sid != server.ServerId)
            throw DomainException.Forbidden("channel is not in your active server");
        var name = cmd.Name is null ? null : TextSanitizer.StripHtml(cmd.Name);
        var topic = cmd.Topic is null ? null : TextSanitizer.StripHtml(cmd.Topic);

        if (!await channels.UpdateAsync(cmd.Id, name, topic, cmd.SlowMode, cmd.Position, cmd.Archived, ct))
            throw DomainException.NotFound("channel not found");

        var updated = await channels.GetByIdAsync(cmd.Id, ct) ?? throw DomainException.NotFound("channel not found");
        return ChannelMapper.ToDto(updated);
    }
}
