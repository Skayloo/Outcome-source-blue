using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;

namespace Outcome.Application.Dm;

// ── DELETE /api/v1/dms/{channelId} ───────────────────────────────────────────
public sealed record CloseDmCommand(long UserId, long ChannelId) : ICommand;
