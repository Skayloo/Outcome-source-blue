using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

// ── users ────────────────────────────────────────────────────────────────────
public sealed record ListAdminUsersQuery(long Permissions, int Limit = int.MaxValue, int Offset = 0, string? Search = null) : IQuery<Paged<AdminUserDto>>;
