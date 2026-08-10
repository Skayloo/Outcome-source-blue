using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Channels;
using Outcome.Domain.Errors;
using Outcome.Domain.Permissions;

namespace Outcome.Application.Search;

public sealed record SearchResultDto(
    long MessageId, long ChannelId, string ChannelName, UserPublicDto User, string Content, DateTime Timestamp);

public sealed record SearchResponse(IReadOnlyList<SearchResultDto> Results);
