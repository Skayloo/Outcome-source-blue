using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Roles;

// ── queries ──────────────────────────────────────────────────────────────────
public sealed record ListRolesQuery : IQuery<IReadOnlyList<RoleDto>>;
