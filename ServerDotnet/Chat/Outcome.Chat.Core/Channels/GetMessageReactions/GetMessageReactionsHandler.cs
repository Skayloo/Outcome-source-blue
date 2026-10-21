using MediatR;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Channels;

/// <summary>
/// Who reacted to a message. Exactly the people who may read the message may see it — the same
/// rule as its history (GetChannelMessagesHandler): a DM's two participants; in a server, the
/// active server's members with READ_MESSAGES on that channel. Anyone else gets the same opaque
/// answer as for a message that does not exist, so the route cannot be used to find messages.
/// </summary>
public sealed class GetMessageReactionsHandler(
    ICurrentUser current,
    ICurrentServer server,
    IMessageRepository messages,
    IChannelRepository channels,
    IChannelOverrideRepository overrides,
    IDmRepository dms,
    IReactionRepository reactions) : IRequestHandler<GetMessageReactionsQuery, MessageReactionsResponse>
{
    public async Task<MessageReactionsResponse> Handle(GetMessageReactionsQuery q, CancellationToken ct)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        var msg = await messages.GetByIdAsync(q.MessageId, ct) ?? throw DomainException.NotFound("message not found");
        var channel = await channels.GetByIdAsync(msg.ChannelId, ct) ?? throw DomainException.NotFound("message not found");

        if (channel.Type == "dm")
        {
            if (!await dms.IsParticipantAsync(current.UserId, msg.ChannelId, ct))
                throw DomainException.NotFound("message not found");
        }
        else
        {
            if (channel.ServerId is { } sid && sid != server.ServerId)
                throw DomainException.NotFound("message not found");
            if (!await CanReadAsync(msg.ChannelId, ct))
                throw DomainException.NotFound("message not found");
        }

        var rows = await reactions.ListForMessageAsync(q.MessageId, ct);
        // Emojis in the order they first appeared (the order the chips under the message use);
        // people within one emoji newest first.
        var groups = rows
            .GroupBy(r => r.Emoji)
            .OrderBy(g => g.Min(r => r.ReactionId))
            .Select(g => new ReactionGroupDto(g.Key, g.Count(),
                g.OrderByDescending(r => r.ReactionId).Select(r => new ReactorUserDto(r.UserId, r.Username, r.Avatar)).ToList()))
            .ToList();
        return new MessageReactionsResponse(q.MessageId, groups);
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
