using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Channels;

public sealed record GetChannelMessagesQuery(long ChannelId, long Before, int Limit)
    : IQuery<ChannelMessagesResponse>;
