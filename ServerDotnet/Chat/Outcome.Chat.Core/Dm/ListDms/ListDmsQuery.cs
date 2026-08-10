using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Dm;

// ── GET /api/v1/dms ──────────────────────────────────────────────────────────
public sealed record ListDmsQuery(long UserId) : IQuery<DmListResponse>;
