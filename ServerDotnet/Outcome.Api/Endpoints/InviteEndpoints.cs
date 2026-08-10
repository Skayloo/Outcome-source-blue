using MediatR;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Invites;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class InviteEndpoints
{
    public sealed record CreateInviteBody(int MaxUses, int ExpiresInHours);

    public static void MapInviteEndpoints(this IEndpointRouteBuilder app)
    {

        app.MapPost("/api/v1/invites", async (CreateInviteBody? body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var b = body ?? new CreateInviteBody(0, 0);
            var dto = await mediator.Send(new CreateInviteCommand(b.MaxUses, b.ExpiresInHours, current.UserId, current.Permissions));
            return dto;
        });

        app.MapGet("/api/v1/invites", async (int? limit, int? offset, HttpContext ctx, ICurrentUser current, ICurrentServer srv, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var page = await mediator.Send(new ListInvitesQuery(current.Permissions, srv.ServerId, limit ?? int.MaxValue, offset ?? 0));
            ctx.Response.Headers["X-Total-Count"] = page.Total.ToString();
            return page.Items;
        });

        app.MapDelete("/api/v1/invites/{code}", async (string code, ICurrentUser current, ICurrentServer srv, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new RevokeInviteCommand(code, current.Permissions, srv.ServerId));
            return Results.NoContent();
        });
    }
}
