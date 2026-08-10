using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Channels;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Search;

public sealed record SearchMessagesQuery(string Query, long? ChannelId, int Limit, long Permissions, long RoleId)
    : IQuery<SearchResponse>;
