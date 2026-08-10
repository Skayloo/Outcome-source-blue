using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

/// <summary>Kick = revoke all of a user's sessions (force re-auth). The caller also force-closes
/// their live WS connection and broadcasts member_leave.</summary>
public sealed record KickUserCommand(long TargetId, long ActorId, long Permissions) : ICommand;
