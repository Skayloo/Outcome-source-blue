using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Realtime;

public sealed record ReactionResult(long MessageId, long ChannelId, string Emoji, long UserId, string Action);
