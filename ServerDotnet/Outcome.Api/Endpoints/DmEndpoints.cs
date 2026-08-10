using System.Text;
using MediatR;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Dm;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class DmEndpoints
{
    public sealed record CreateDmBody(long RecipientId);

    public static void MapDmEndpoints(this IEndpointRouteBuilder app)
    {

        app.MapPost("/api/v1/dms", async (CreateDmBody body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("authentication required");
            var result = await mediator.Send(new CreateOrOpenDmCommand(current.UserId, body.RecipientId));
            return result;
        });

        app.MapGet("/api/v1/dms", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("authentication required");
            return await mediator.Send(new ListDmsQuery(current.UserId));
        });

        app.MapDelete("/api/v1/dms/{channelId:long}", async (long channelId, ICurrentUser current, IConnectionRegistry registry, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("authentication required");
            await mediator.Send(new CloseDmCommand(current.UserId, channelId));
            // Update the closing user's sidebar in real time.
            var frame = Encoding.UTF8.GetBytes($"{{\"type\":\"dm_channel_close\",\"payload\":{{\"channel_id\":{channelId}}}}}");
            await registry.SendToUserAsync(current.UserId, frame);
            return Results.NoContent();
        });
    }
}
