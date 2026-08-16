using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Dm;

public sealed class CreateOrOpenDmHandler(IDmRepository dms, IUserRepository users, IBlockRepository blocks)
    : IRequestHandler<CreateOrOpenDmCommand, CreateDmResult>
{
    public async Task<CreateDmResult> Handle(CreateOrOpenDmCommand cmd, CancellationToken ct)
    {
        if (cmd.RecipientId <= 0) throw DomainException.BadRequest("recipient_id must be a positive integer");
        if (cmd.RecipientId == cmd.UserId) throw DomainException.BadRequest("cannot create a DM with yourself");

        var recipient = await users.GetByIdAsync(cmd.RecipientId, ct) ?? throw DomainException.NotFound("recipient not found");

        // A block in EITHER direction closes the DM door for both sides.
        if (await blocks.IsBlockedEitherWayAsync(cmd.UserId, cmd.RecipientId, ct))
            throw DomainException.Forbidden("you cannot message this user");

        var existing = await dms.FindChannelAsync(cmd.UserId, cmd.RecipientId, ct);
        long channelId;
        bool created;
        if (existing is { } id)
        {
            channelId = id;
            created = false;
            await dms.OpenAsync(cmd.UserId, channelId, ct); // reopen for the requester
        }
        else
        {
            channelId = await dms.CreateChannelAsync(cmd.UserId, cmd.RecipientId, ct);
            created = true;
        }

        return new CreateDmResult(
            channelId,
            new DmUserDto(recipient.Id, recipient.Username, recipient.Avatar ?? string.Empty, recipient.Status),
            created);
    }
}
