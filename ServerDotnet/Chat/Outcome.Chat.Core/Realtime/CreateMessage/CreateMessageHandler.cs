using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Errors;
using Outcome.Shared.Abstractions.Security;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Realtime;

public sealed class CreateMessageHandler(
    IChannelRepository channels,
    IChannelOverrideRepository overrides,
    IMessageRepository messages,
    IAttachmentRepository attachments,
    IDmRepository dms,
    IBlockRepository blocks,
    IServerRepository servers,
    IPermissionRepository permissions,
    IFileUrlSigner fileUrls) : IRequestHandler<CreateMessageCommand, CreatedMessage>
{
    private const int MaxMessageLength = 4000;
    // A recording posts two files, the composer a handful; ten matches what Discord allows.
    private const int MaxAttachments = 10;

    public async Task<CreatedMessage> Handle(CreateMessageCommand cmd, CancellationToken ct)
    {
        var channel = await channels.GetByIdAsync(cmd.ChannelId, ct)
                      ?? throw DomainException.NotFound("channel not found");

        IReadOnlyList<long>? dmParticipants = null;
        if (channel.Type == "dm")
        {
            if (!await dms.IsParticipantAsync(cmd.UserId, cmd.ChannelId, ct))
                throw DomainException.Forbidden("you are not a participant in this DM");
            dmParticipants = await dms.GetParticipantIdsAsync(cmd.ChannelId, ct);
            // An existing DM goes silent the moment either side blocks the other.
            var other = dmParticipants.FirstOrDefault(p => p != cmd.UserId);
            if (other != 0 && await blocks.IsBlockedEitherWayAsync(cmd.UserId, other, ct))
                throw DomainException.Forbidden("you cannot message this user");
        }
        else
        {
            var permBits = cmd.Permissions;
            var roleId = cmd.RoleId;
            if (channel.ServerId is { } sid && sid != cmd.ServerId)
            {
                // Cross-server post (forwarding): allowed for MEMBERS of the target server, judged
                // by what they hold THERE — computed exactly as for the active server (space role's
                // claims + that server role's grant). It read the drifted roles.permissions column
                // of a role id that fell back to the ACTIVE server's role, so a Moderator somewhere
                // else (say, in a server of one's own) passed a private channel's overrides here.
                if (!await servers.IsMemberAsync(sid, cmd.UserId, ct))
                    throw DomainException.Forbidden("you are not a member of that server");
                permBits = Perms.ToBits(await permissions.GetEffectiveForServerAsync(cmd.UserId, sid, ct));
            }

            var baseNames = Perms.FromBits(permBits);
            if (!baseNames.Contains(Perms.Administrator))
            {
                var ovr = await overrides.GetForRoleAsync(roleId, ct);
                ovr.TryGetValue(cmd.ChannelId, out var o);
                var effective = Perms.ApplyOverride(baseNames, o.Allow, o.Deny);
                if (!effective.Contains(Perms.ReadMessages) || !effective.Contains(Perms.SendMessages))
                    throw DomainException.Forbidden("no permission to send in this channel");
            }
        }

        // One frame used to carry ~27 000 copies of one id: a read check and a cloned row each,
        // inside one transaction, and a multi-megabyte chat_message to everyone in the channel.
        if (cmd.Attachments.Distinct().Count() > MaxAttachments)
            throw DomainException.BadRequest($"a message can carry at most {MaxAttachments} files");

        var content = TextSanitizer.StripHtml(cmd.Content);
        if (content.Length == 0 && cmd.Attachments.Count == 0)
            throw DomainException.BadRequest("message content cannot be empty");

        // The content filter guideline 1.2 requires, and terms.html promises. It sees plaintext
        // only: a DM on a red server arrives as ciphertext, so what comes through here for one
        // is an opaque blob the filter folds to nothing and passes. That is not a hole to plug
        // — it is the point of the encryption — and reporting covers what the server cannot read.
        if (ContentFilter.FirstProhibited(content) is { } hit)
            throw DomainException.ContentBlocked($"this message was blocked by the content filter ({hit})");
        if (content.Length > MaxMessageLength)
            throw DomainException.BadRequest($"message content exceeds maximum length of {MaxMessageLength} characters");

        // Forward label: a display string, not a user reference (the source may be an E2EE
        // DM this server cannot read). Sanitized and capped like any other user text.
        var forwardedFrom = string.IsNullOrWhiteSpace(cmd.ForwardedFrom)
            ? null
            : TextSanitizer.StripHtml(cmd.ForwardedFrom).Trim() is { Length: > 0 } f
                ? (f.Length > 64 ? f[..64] : f)
                : null;

        var (id, timestamp) = await messages.CreateAsync(cmd.ChannelId, cmd.UserId, content, cmd.ReplyTo, forwardedFrom, ct);

        var linked = cmd.Attachments.Count > 0
            ? await attachments.AttachToMessageAsync(cmd.Attachments.Distinct().ToList(), id, cmd.UserId, ct)
            : (IReadOnlyList<Domain.Entities.Attachment>)Array.Empty<Domain.Entities.Attachment>();
        var attachmentDtos = linked
            .Select(a => new AttachmentDto(a.Id, a.Filename, a.Size, a.MimeType, fileUrls.Sign(a.Id), a.Width, a.Height, a.DurationMs, a.Waveform))
            .ToList();

        return new CreatedMessage(id, timestamp, content, channel.Type, dmParticipants, attachmentDtos, forwardedFrom, channel.ServerId);
    }
}
