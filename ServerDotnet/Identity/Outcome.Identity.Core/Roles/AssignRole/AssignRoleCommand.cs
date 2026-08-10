using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Entities;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Roles;

// ── assign ───────────────────────────────────────────────────────────────────
public sealed record AssignRoleCommand(long UserId, long RoleId, long ActorPermissions) : ICommand;
