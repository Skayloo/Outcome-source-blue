using MediatR;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Media;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class MediaEndpoints
{
    public static void MapMediaEndpoints(this IEndpointRouteBuilder app)
    {
        // ── Custom emoji ─────────────────────────────────────────────────────────
        app.MapGet("/api/v1/emoji", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new ListEmojiQuery());
        });

        app.MapDelete("/api/v1/emoji/{id:long}", async (long id, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new DeleteEmojiCommand(id, current.Permissions));
            return Results.NoContent();
        });

        // ── Soundboard sounds ────────────────────────────────────────────────────
        app.MapGet("/api/v1/sounds", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new ListSoundsQuery());
        });

        app.MapDelete("/api/v1/sounds/{id:long}", async (long id, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new DeleteSoundCommand(id, current.Permissions));
            return Results.NoContent();
        });
    }
}
