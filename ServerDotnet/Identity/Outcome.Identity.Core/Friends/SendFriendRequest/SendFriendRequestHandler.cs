using MediatR;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Friends;

public sealed class SendFriendRequestHandler(IFriendRepository friends, IUserRepository users, IBlockRepository blocks)
    : IRequestHandler<SendFriendRequestCommand, SendFriendRequestResult>
{
    public async Task<SendFriendRequestResult> Handle(SendFriendRequestCommand cmd, CancellationToken ct)
    {
        if (cmd.ToUserId <= 0) throw DomainException.BadRequest("user_id must be a positive integer");
        if (cmd.ToUserId == cmd.FromUserId) throw DomainException.BadRequest("cannot add yourself as a friend");

        _ = await users.GetByIdAsync(cmd.ToUserId, ct) ?? throw DomainException.NotFound("user not found");

        // Neither side of a block can start a friendship (deliberately the same wording as a
        // missing user — a blocked requester learns nothing).
        if (await blocks.IsBlockedEitherWayAsync(cmd.FromUserId, cmd.ToUserId, ct))
            throw DomainException.NotFound("user not found");

        var (created, autoAccepted) = await friends.SendRequestAsync(cmd.FromUserId, cmd.ToUserId, ct);
        return new SendFriendRequestResult(created, autoAccepted);
    }
}
