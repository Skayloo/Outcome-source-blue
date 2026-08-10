using MediatR;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Friends;

public sealed class RemoveFriendHandler(IFriendRepository friends)
    : IRequestHandler<RemoveFriendCommand, bool>
{
    public async Task<bool> Handle(RemoveFriendCommand cmd, CancellationToken ct)
    {
        if (cmd.OtherId <= 0) throw DomainException.BadRequest("user_id must be a positive integer");
        return await friends.RemoveAsync(cmd.UserId, cmd.OtherId, ct);
    }
}
