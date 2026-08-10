using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Realtime;

public sealed class ReactHandler(
    IMessageRepository messages,
    IChannelRepository channels,
    IChannelOverrideRepository overrides,
    IReactionRepository reactions) : IRequestHandler<ReactCommand, ReactionResult>
{
    public async Task<ReactionResult> Handle(ReactCommand cmd, CancellationToken ct)
    {
        var emoji = cmd.Emoji ?? string.Empty;
        if (emoji.Length == 0) throw DomainException.BadRequest("emoji cannot be empty");
        if (emoji.Length > 32) throw DomainException.BadRequest("emoji too long");
        foreach (var ch in emoji)
            if (ch < 0x20 || ch == 0x7F)
                throw DomainException.BadRequest("emoji contains invalid characters");

        // Opaque error to avoid leaking message visibility (IDOR).
        var msg = await messages.GetByIdAsync(cmd.MessageId, ct) ?? throw DomainException.BadRequest("reaction failed");
        var channel = await channels.GetByIdAsync(msg.ChannelId, ct) ?? throw DomainException.BadRequest("reaction failed");

        if (channel.Type != "dm")
        {
            if (channel.ServerId is { } sid && sid != cmd.ServerId)
                throw DomainException.Forbidden("channel is not in your active server");
            if (!await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, msg.ChannelId, Perms.AddReactions, ct))
                throw DomainException.Forbidden("no permission to react in this channel");
        }

        if (cmd.Add) await reactions.AddAsync(cmd.MessageId, cmd.UserId, emoji, ct);
        else await reactions.RemoveAsync(cmd.MessageId, cmd.UserId, emoji, ct);

        return new ReactionResult(cmd.MessageId, msg.ChannelId, emoji, cmd.UserId, cmd.Add ? "add" : "remove");
    }
}
