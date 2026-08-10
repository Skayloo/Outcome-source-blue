using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

using Outcome.Application.Common;

namespace Outcome.Application.Admin;

/// <summary>GET /api/v1/admin/audit-log — paginated audit entries (newest first), actor names joined.</summary>
public sealed record GetAuditLogQuery(long Permissions, int Limit, int Offset) : IQuery<Paged<AuditEntryDto>>;

public sealed class GetAuditLogHandler(IAdminMetricsRepository metrics)
    : IRequestHandler<GetAuditLogQuery, Paged<AuditEntryDto>>
{
    public async Task<Paged<AuditEntryDto>> Handle(GetAuditLogQuery q, CancellationToken ct)
    {
        AdminAuth.Require(q.Permissions, Perms.ViewAuditLog);
        var limit = Math.Clamp(q.Limit <= 0 ? 50 : q.Limit, 1, 200);
        var offset = Math.Max(0, q.Offset);
        return new(await metrics.GetAuditAsync(limit, offset, ct), await metrics.CountAuditAsync(ct));
    }
}
