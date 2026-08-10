using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Realtime;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Channels;

// ── GET /channels/{id}/pins (ReadMessages) ───────────────────────────────────
public sealed record GetChannelPinsQuery(long ChannelId, long UserId, long Permissions, long RoleId)
    : IQuery<ChannelMessagesResponse>;
