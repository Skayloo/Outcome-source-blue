using MediatR;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Application.Users;

public sealed class GetMyPermissionsQueryHandler(IPermissionRepository permissions)
    : IRequestHandler<GetMyPermissionsQuery, IReadOnlyList<string>>
{
    public Task<IReadOnlyList<string>> Handle(GetMyPermissionsQuery q, CancellationToken ct) =>
        permissions.GetEffectiveAsync(q.UserId, ct);
}
