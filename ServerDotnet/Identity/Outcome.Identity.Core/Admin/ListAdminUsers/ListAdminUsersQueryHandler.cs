using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

using Outcome.Application.Common;

namespace Outcome.Application.Admin;

public sealed class ListAdminUsersHandler(IUserRepository users)
    : IRequestHandler<ListAdminUsersQuery, Paged<AdminUserDto>>
{
    public async Task<Paged<AdminUserDto>> Handle(ListAdminUsersQuery q, CancellationToken ct)
    {
        AdminAuth.Require(q.Permissions, Outcome.Shared.Abstractions.Authorization.Permissions.ManageServer);
        return new(
            await users.ListAdminUsersAsync(Math.Clamp(q.Limit, 1, int.MaxValue), Math.Max(0, q.Offset), q.Search, ct),
            await users.CountAdminUsersAsync(q.Search, ct));
    }
}
