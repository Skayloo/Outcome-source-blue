using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Realtime;

/// <summary>reaction_add / reaction_remove over WS. Add flag distinguishes the two.</summary>
public sealed record ReactCommand(long MessageId, string Emoji, bool Add, long UserId, long Permissions, long RoleId, long ServerId)
    : ICommand<ReactionResult>;
