using MediatR;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Search;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class SearchEndpoints
{
    public static void MapSearchEndpoints(this IEndpointRouteBuilder app)
    {
        // GET /api/v1/search?q=...&channel_id=...&limit=...
        app.MapGet("/api/v1/search", async (string? q, long? channel_id, int? limit, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new SearchMessagesQuery(q ?? string.Empty, channel_id, limit ?? 50, current.Permissions, current.RoleId));
        });
    }
}
