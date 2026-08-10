using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Dm;

// ── POST /api/v1/dms ─────────────────────────────────────────────────────────
public sealed record CreateOrOpenDmCommand(long UserId, long RecipientId) : ICommand<CreateDmResult>;
