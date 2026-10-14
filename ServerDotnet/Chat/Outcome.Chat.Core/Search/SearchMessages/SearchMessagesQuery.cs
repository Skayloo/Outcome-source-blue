using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Channels;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Search;

/// <summary><paramref name="ServerId"/> is the caller's ACTIVE server, which CurrentServerMiddleware
/// admits only for a member — search reads what history reads, nothing wider.</summary>
public sealed record SearchMessagesQuery(string Query, long? ChannelId, int Limit, long Permissions, long RoleId, long ServerId = 0)
    : IQuery<SearchResponse>;
