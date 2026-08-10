using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Channels;

public sealed class GetChannelMessagesHandler(
    ICurrentUser current,
    ICurrentServer server,
    IChannelRepository channels,
    IChannelOverrideRepository overrides,
    IDmRepository dms,
    IMessageRepository messages) : IRequestHandler<GetChannelMessagesQuery, ChannelMessagesResponse>
{
    private const int DefaultLimit = 50;
    private const int MaxLimit = 100;

    public async Task<ChannelMessagesResponse> Handle(GetChannelMessagesQuery q, CancellationToken ct)
    {
        if (!current.IsAuthenticated)
            throw DomainException.Unauthorized("not authenticated");

        var channel = await channels.GetByIdAsync(q.ChannelId, ct)
                      ?? throw DomainException.NotFound("channel not found");

        // DMs: only participants may read the history. Other channels: the channel must belong to
        // the caller's active server (which the middleware validated is one they're a member of),
        // AND they must have role-based READ_MESSAGES.
        if (channel.Type == "dm")
        {
            if (!await dms.IsParticipantAsync(current.UserId, q.ChannelId, ct))
                throw DomainException.Forbidden("you are not a participant in this DM");
        }
        else
        {
            if (channel.ServerId is { } sid && sid != server.ServerId)
                throw DomainException.Forbidden("channel is not in your active server");
            if (!await CanReadAsync(q.ChannelId, ct))
                throw DomainException.Forbidden("no permission to view this channel");
        }

        var limit = q.Limit < 1 ? DefaultLimit : Math.Min(q.Limit, MaxLimit);
        var before = q.Before < 0 ? 0 : q.Before;

        // Fetch one extra to determine has_more.
        var rows = await messages.GetForApiAsync(q.ChannelId, before, limit + 1, current.UserId, ct);
        var hasMore = rows.Count > limit;
        var page = hasMore ? rows.Take(limit).ToList() : rows;
        return new ChannelMessagesResponse(page, hasMore);
    }

    private async Task<bool> CanReadAsync(long channelId, CancellationToken ct)
    {
        var baseNames = current.PermissionNames;
        if (baseNames.Contains(Perms.Administrator)) return true;
        var ovr = await overrides.GetForRoleAsync(current.RoleId, ct);
        ovr.TryGetValue(channelId, out var o);
        return Perms.ApplyOverride(baseNames, o.Allow, o.Deny).Contains(Perms.ReadMessages);
    }
}
