using MediatR;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Channels;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class ChannelEndpoints
{
    public static void MapChannelEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/channels", async (ISender mediator) =>
            await mediator.Send(new ListChannelsQuery()));

        app.MapGet("/api/v1/channels/{id:long}/messages", async (long id, long? before, int? limit, ISender mediator) =>
            await mediator.Send(new GetChannelMessagesQuery(id, before ?? 0, limit ?? 50)));

        // ── per-user notification mute (chat context menu) ───────────────────
        app.MapPut("/api/v1/channels/{id:long}/mute", async (long id, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new SetChannelMuteCommand(id, current.UserId, true));
            return Results.NoContent();
        });

        app.MapDelete("/api/v1/channels/{id:long}/mute", async (long id, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new SetChannelMuteCommand(id, current.UserId, false));
            return Results.NoContent();
        });

        // ── pinned messages ──────────────────────────────────────────────────
        app.MapGet("/api/v1/channels/{id:long}/pins", async (long id, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new GetChannelPinsQuery(id, current.UserId, current.Permissions, current.RoleId));
        });

        app.MapPost("/api/v1/channels/{id:long}/pins/{messageId:long}", async (long id, long messageId, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new SetPinCommand(id, messageId, true, current.UserId, current.Permissions, current.RoleId));
            return Results.NoContent();
        });

        app.MapDelete("/api/v1/channels/{id:long}/pins/{messageId:long}", async (long id, long messageId, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new SetPinCommand(id, messageId, false, current.UserId, current.Permissions, current.RoleId));
            return Results.NoContent();
        });
    }
}
