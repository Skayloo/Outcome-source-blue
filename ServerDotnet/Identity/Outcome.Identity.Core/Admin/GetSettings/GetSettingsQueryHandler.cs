using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

public sealed class GetSettingsHandler(ISettingsRepository settings)
    : IRequestHandler<GetSettingsQuery, IReadOnlyDictionary<string, string>>
{
    public async Task<IReadOnlyDictionary<string, string>> Handle(GetSettingsQuery q, CancellationToken ct)
    {
        AdminAuth.Require(q.Permissions, Outcome.Shared.Abstractions.Authorization.Permissions.ManageServer);
        return await settings.GetAllAsync(ct);
    }
}
