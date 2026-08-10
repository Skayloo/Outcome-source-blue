using MediatR;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Roles;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class RoleEndpoints
{
    public sealed record CreateRoleBody(string Name, string? Color, long Permissions, int Position);
    public sealed record UpdateRoleBody(string? Name, string? Color, long? Permissions, int? Position);
    public sealed record AssignRoleBody(long RoleId);

    public static void MapRoleEndpoints(this IEndpointRouteBuilder app)
    {

        app.MapGet("/api/v1/roles", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new ListRolesQuery());
        });

        app.MapPost("/api/v1/roles", async (CreateRoleBody body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var dto = await mediator.Send(new CreateRoleCommand(body.Name, body.Color, body.Permissions, body.Position, current.Permissions));
            return dto;
        });

        app.MapPatch("/api/v1/roles/{id:long}", async (long id, UpdateRoleBody body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new UpdateRoleCommand(id, body.Name, body.Color, body.Permissions, body.Position, current.Permissions));
        });

        app.MapDelete("/api/v1/roles/{id:long}", async (long id, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new DeleteRoleCommand(id, current.Permissions));
            return Results.NoContent();
        });

        app.MapPost("/api/v1/users/{userId:long}/role", async (long userId, AssignRoleBody body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new AssignRoleCommand(userId, body.RoleId, current.Permissions));
            return Results.NoContent();
        });
    }
}
