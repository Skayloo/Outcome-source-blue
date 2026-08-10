using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Channels;

public sealed class GetChannelPinsHandler(
    IChannelRepository channels, IChannelOverrideRepository overrides, IMessageRepository messages, IDmRepository dms, ICurrentServer server)
    : IRequestHandler<GetChannelPinsQuery, ChannelMessagesResponse>
{
    private const int Limit = 50;

    public async Task<ChannelMessagesResponse> Handle(GetChannelPinsQuery q, CancellationToken ct)
    {
        var channel = await channels.GetByIdAsync(q.ChannelId, ct) ?? throw DomainException.NotFound("channel not found");
        if (channel.Type == "dm")
        {
            // DMs: only participants may read pins (mirrors GetChannelMessagesHandler).
            if (!await dms.IsParticipantAsync(q.UserId, q.ChannelId, ct))
                throw DomainException.Forbidden("you are not a participant in this DM");
        }
        else
        {
            if (channel.ServerId is { } sid && sid != server.ServerId)
                throw DomainException.Forbidden("channel is not in your active server");
            if (!await PermCheck.HasAsync(overrides, q.Permissions, q.RoleId, q.ChannelId, Perms.ReadMessages, ct))
                throw DomainException.Forbidden("no permission to view this channel");
        }

        var rows = await messages.GetForApiAsync(q.ChannelId, 0, Limit + 1, q.UserId, ct, pinnedOnly: true);
        var hasMore = rows.Count > Limit;
        return new ChannelMessagesResponse(hasMore ? rows.Take(Limit).ToList() : rows, hasMore);
    }
}
