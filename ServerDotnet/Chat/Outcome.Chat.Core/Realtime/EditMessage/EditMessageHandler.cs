using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Realtime;

public sealed class EditMessageHandler(
    IMessageRepository messages, IChannelRepository channels, IChannelOverrideRepository overrides)
    : IRequestHandler<EditMessageCommand, EditedMessage>
{
    public async Task<EditedMessage> Handle(EditMessageCommand cmd, CancellationToken ct)
    {
        var content = TextSanitizer.StripHtml(cmd.Content);
        if (content.Length == 0) throw DomainException.BadRequest("content cannot be empty");
        if (content.Length > 4000) throw DomainException.BadRequest("message too long");

        // The same filter as CreateMessageHandler, and for the obvious reason: a filter that
        // only looks at the first version of a message is bypassed by sending something bland
        // and then editing it. Both doors or neither.
        if (ContentFilter.FirstProhibited(content) is { } hit)
            throw DomainException.ContentBlocked($"this message was blocked by the content filter ({hit})");

        // Opaque error throughout to prevent message-id enumeration (IDOR).
        var msg = await messages.GetByIdAsync(cmd.MessageId, ct) ?? throw Cannot();
        var channel = await channels.GetByIdAsync(msg.ChannelId, ct) ?? throw Cannot();
        if (channel.Type != "dm")
        {
            if (channel.ServerId is { } sid && sid != cmd.ServerId) throw Cannot();
            if (!await PermCheck.HasAsync(overrides, cmd.Permissions, cmd.RoleId, msg.ChannelId, Perms.SendMessages, ct))
                throw Cannot();
        }

        var editedAt = await messages.EditAsync(cmd.MessageId, cmd.UserId, content, ct) ?? throw Cannot();
        return new EditedMessage(cmd.MessageId, msg.ChannelId, content, editedAt);
    }

    private static DomainException Cannot() => DomainException.Forbidden("cannot edit this message");
}

/// <summary>
/// Shared channel permission check: admin bypass, then claim-based per-channel override math
/// (<c>effective = (base \ deny) ∪ allow</c>). <paramref name="permissions"/> is the actor's
/// claim-derived bitfield (from the WS command); <paramref name="required"/> is a permission name.
/// </summary>
internal static class PermCheck
{
    public static async Task<bool> HasAsync(
        IChannelOverrideRepository overrides, long permissions, long roleId, long channelId, string required, CancellationToken ct)
    {
        var baseNames = Perms.FromBits(permissions);
        if (baseNames.Contains(Perms.Administrator)) return true;
        var ovr = await overrides.GetForRoleAsync(roleId, ct);
        ovr.TryGetValue(channelId, out var o);
        return Perms.ApplyOverride(baseNames, o.Allow, o.Deny).Contains(required);
    }
}
