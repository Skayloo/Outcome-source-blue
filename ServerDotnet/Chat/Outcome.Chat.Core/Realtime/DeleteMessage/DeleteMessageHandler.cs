using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Realtime;

public sealed class DeleteMessageHandler(
    IMessageRepository messages, IChannelRepository channels, IChannelOverrideRepository overrides,
    IDmRepository dms)
    : IRequestHandler<DeleteMessageCommand, DeletedMessage>
{
    public async Task<DeletedMessage> Handle(DeleteMessageCommand cmd, CancellationToken ct)
    {
        var msg = await messages.GetByIdAsync(cmd.MessageId, ct) ?? throw Cannot();
        var channel = await channels.GetByIdAsync(msg.ChannelId, ct) ?? throw Cannot();

        // A DM belongs to its two participants and to nobody else — not even the instance
        // owner, who has no business in it. Either of them may delete anything in it, for
        // both sides (Telegram semantics), and the row is PURGED rather than tombstoned:
        // a private conversation should not leave its contents sitting in the database
        // after the people in it agreed to erase them.
        if (channel.Type == "dm")
        {
            // The ONLY gate that matters here: is the caller in THIS conversation? Checked
            // against the message's own channel — never a channel id supplied by the client —
            // so a participant of one DM cannot reach into anybody else's.
            if (!await dms.IsParticipantAsync(cmd.UserId, msg.ChannelId, ct)) throw Cannot();
            if (!await messages.PurgeAsync(cmd.MessageId, ct)) throw Cannot();
            var participants = await dms.GetParticipantIdsAsync(msg.ChannelId, ct);
            return new DeletedMessage(cmd.MessageId, msg.ChannelId, Purged: true, DmParticipantIds: participants);
        }

        // Server channels keep the tombstone: moderation stays visible ("message deleted"),
        // and an author can only remove their own unless they hold ManageMessages.
        if (channel.ServerId is { } sid && sid != cmd.ServerId) throw Cannot();
        if (!await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, msg.ChannelId, Perms.ReadMessages, ct))
            throw Cannot();
        var isMod = await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, msg.ChannelId, Perms.ManageMessages, ct);

        if (!await messages.DeleteAsync(cmd.MessageId, cmd.UserId, isMod, ct)) throw Cannot();
        return new DeletedMessage(cmd.MessageId, msg.ChannelId, Purged: false);
    }

    private static DomainException Cannot() => DomainException.Forbidden("cannot delete this message");
}
