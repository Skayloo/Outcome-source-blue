using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Common;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Channels;

internal static class ChannelAdminAuth
{
    public static void Require(long permissions)
    {
        if (!Perms.Grants(Perms.FromBits(permissions), Perms.ManageChannels))
            throw DomainException.Forbidden("insufficient permissions to manage channels");
    }
}

public sealed class CreateChannelHandler(IChannelRepository channels, ICurrentServer server) : IRequestHandler<CreateChannelCommand, ChannelDto>
{
    public async Task<ChannelDto> Handle(CreateChannelCommand cmd, CancellationToken ct)
    {
        ChannelAdminAuth.Require(cmd.Permissions);
        var name = TextSanitizer.StripHtml(cmd.Name);
        if (name.Length == 0) throw DomainException.BadRequest("channel name is required");
        var type = cmd.Type is "text" or "voice" or "announcement" ? cmd.Type : "text";

        var id = await channels.CreateAsync(new Channel
        {
            ServerId = server.ServerId,
            Name = name,
            Type = type,
            Category = string.IsNullOrWhiteSpace(cmd.Category) ? null : TextSanitizer.StripHtml(cmd.Category),
            Topic = TextSanitizer.StripHtml(cmd.Topic),
            Position = cmd.Position,
        }, ct);

        var created = await channels.GetByIdAsync(id, ct)
                      ?? throw DomainException.Server("channel not found after create");
        return ChannelMapper.ToDto(created);
    }
}
