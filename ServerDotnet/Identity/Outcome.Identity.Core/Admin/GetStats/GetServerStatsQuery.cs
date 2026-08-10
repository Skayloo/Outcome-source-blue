using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Admin;

/// <summary>GET /api/v1/admin/stats — diagnostics counters (DB-derived).</summary>
public sealed record GetServerStatsQuery(long Permissions) : IQuery<AdminStatsDto>;

public sealed class GetServerStatsHandler(IAdminMetricsRepository metrics)
    : IRequestHandler<GetServerStatsQuery, AdminStatsDto>
{
    public async Task<AdminStatsDto> Handle(GetServerStatsQuery q, CancellationToken ct)
    {
        AdminAuth.Require(q.Permissions, Perms.ManageServer);
        return await metrics.GetStatsAsync(ct);
    }
}
