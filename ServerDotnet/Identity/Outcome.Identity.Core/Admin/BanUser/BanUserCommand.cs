using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Admin;

public sealed record BanUserCommand(long TargetId, string Reason, long ActorId, long Permissions) : ICommand;
