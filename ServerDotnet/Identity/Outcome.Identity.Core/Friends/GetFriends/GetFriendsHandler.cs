using MediatR;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Application.Friends;

public sealed class GetFriendsHandler(IFriendRepository friends)
    : IRequestHandler<GetFriendsQuery, FriendsListDto>
{
    public Task<FriendsListDto> Handle(GetFriendsQuery q, CancellationToken ct) =>
        friends.ListAsync(q.UserId, ct);
}
