using MediatR;
using Outcome.Shared.Abstractions.Messaging;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Application.Channels;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Application.Search;

public sealed class SearchMessagesHandler(IMessageRepository messages, IChannelOverrideRepository overrides)
    : IRequestHandler<SearchMessagesQuery, SearchResponse>
{
    public async Task<SearchResponse> Handle(SearchMessagesQuery q, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(q.Query))
            throw DomainException.BadRequest("query parameter 'q' is required");

        var limit = q.Limit < 1 ? 50 : Math.Min(q.Limit, 100);
        var rows = await messages.SearchAsync(q.Query, q.ChannelId, limit, ct);

        var baseNames = Perms.FromBits(q.Permissions);
        var isAdmin = baseNames.Contains(Perms.Administrator);
        var overridesByChannel = isAdmin ? null : await overrides.GetForRoleAsync(q.RoleId, ct);

        var results = new List<SearchResultDto>(rows.Count);
        foreach (var r in rows)
        {
            // DM results require participant auth (added with the DM phase); excluded for now.
            if (r.ChannelType == "dm") continue;

            if (!isAdmin)
            {
                overridesByChannel!.TryGetValue(r.ChannelId, out var o);
                if (!Perms.ApplyOverride(baseNames, o.Allow, o.Deny).Contains(Perms.ReadMessages)) continue;
            }

            results.Add(new SearchResultDto(
                r.MessageId, r.ChannelId, r.ChannelName,
                new UserPublicDto(r.UserId, r.Username, r.Avatar), r.Content, r.Timestamp));
        }

        return new SearchResponse(results);
    }
}
