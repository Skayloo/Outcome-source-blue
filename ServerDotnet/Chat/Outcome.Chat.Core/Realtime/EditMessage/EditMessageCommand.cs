using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Common;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Realtime;

// ── chat_edit ────────────────────────────────────────────────────────────────
public sealed record EditMessageCommand(long MessageId, string Content, long UserId, long Permissions, long RoleId, long ServerId)
    : ICommand<EditedMessage>;
