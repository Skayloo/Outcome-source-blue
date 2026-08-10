using MediatR;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Application.Users;

public sealed class SearchUsersHandler(IUserRepository users)
    : IRequestHandler<SearchUsersQuery, IReadOnlyList<UserSearchDto>>
{
    private const int Limit = 20;

    public async Task<IReadOnlyList<UserSearchDto>> Handle(SearchUsersQuery q, CancellationToken ct)
    {
        var query = q.Query.Trim();
        if (query.Length < 2) return [];
        return await users.SearchAsync(query, q.ExcludeUserId, Limit, ct);
    }
}
