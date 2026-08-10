using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Channels;

public sealed class DeleteChannelHandler(IChannelRepository channels, ICurrentServer server) : IRequestHandler<DeleteChannelCommand>
{
    public async Task Handle(DeleteChannelCommand cmd, CancellationToken ct)
    {
        ChannelAdminAuth.Require(cmd.Permissions);
        var channel = await channels.GetByIdAsync(cmd.Id, ct)
                      ?? throw DomainException.NotFound("channel not found");
        // Even a global-admin/owner may only delete channels of their ACTIVE server (membership-validated).
        if (channel.ServerId is { } sid && sid != server.ServerId)
            throw DomainException.Forbidden("channel is not in your active server");
        if (!await channels.DeleteAsync(cmd.Id, ct))
            throw DomainException.NotFound("channel not found");
    }
}
