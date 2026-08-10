using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Roles;

// ── create ───────────────────────────────────────────────────────────────────
public sealed record CreateRoleCommand(string Name, string? Color, long Permissions, int Position, long ActorPermissions)
    : ICommand<RoleDto>;
