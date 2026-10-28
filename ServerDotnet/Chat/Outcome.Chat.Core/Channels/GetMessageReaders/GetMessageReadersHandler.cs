using MediatR;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Channels;

/// <summary>
/// Who has read a message: everyone whose read marker in its channel has reached it. As in Telegram
/// (the owner, 2026-10-28: "статусы из каналов убрать и показывать, кто прочитал, при правом клике"),
/// only the message's AUTHOR may ask, and only while they may still read the channel — anyone else
/// gets the same answer as for a message that does not exist. A marker moves when someone opens the
/// channel, so "read" means "opened the channel after it was written".
/// </summary>
public sealed class GetMessageReadersHandler(
    ICurrentUser current,
    ICurrentServer server,
    IMessageRepository messages,
    IChannelRepository channels,
    IChannelOverrideRepository overrides,
    IDmRepository dms,
    IReadStateRepository reads) : IRequestHandler<GetMessageReadersQuery, MessageReadersResponse>
{
    public const int Limit = 500;

    public async Task<MessageReadersResponse> Handle(GetMessageReadersQuery q, CancellationToken ct)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        var msg = await messages.GetByIdAsync(q.MessageId, ct);
        if (msg is null || msg.Deleted || msg.UserId != current.UserId) throw DomainException.NotFound("message not found");
        var channel = await channels.GetByIdAsync(msg.ChannelId, ct) ?? throw DomainException.NotFound("message not found");

        if (channel.Type == "dm")
        {
            if (!await dms.IsParticipantAsync(current.UserId, msg.ChannelId, ct))
                throw DomainException.NotFound("message not found");
        }
        else if (channel.ServerId is not { } sid || sid != server.ServerId || !await CanReadAsync(msg.ChannelId, ct))
        {
            throw DomainException.NotFound("message not found");
        }

        var (count, readers) = await reads.ReadersAsync(msg.ChannelId, channel.Type == "dm" ? null : channel.ServerId,
            msg.Id, current.UserId, Limit, ct);
        return new MessageReadersResponse(msg.Id, count, readers.Select(r => new ReactorUserDto(r.UserId, r.Username, r.Avatar)).ToList());
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
