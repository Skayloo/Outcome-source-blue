using MediatR;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Friends;

public sealed class AcceptFriendHandler(IFriendRepository friends)
    : IRequestHandler<AcceptFriendCommand, bool>
{
    public async Task<bool> Handle(AcceptFriendCommand cmd, CancellationToken ct)
    {
        if (cmd.OtherId <= 0) throw DomainException.BadRequest("user_id must be a positive integer");
        if (cmd.OtherId == cmd.UserId) throw DomainException.BadRequest("invalid user");
        return await friends.AcceptAsync(cmd.UserId, cmd.OtherId, ct);
    }
}
