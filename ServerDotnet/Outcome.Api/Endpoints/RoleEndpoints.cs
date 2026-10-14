using MediatR;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Realtime;
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

        // Roles are fixed (2026-10-12, the owner's decision): the space has Owner / Admin / Member,
        // a server has its owner, Admin, Moderator and Member (ServerRoles). The editor these routes
        // served wrote role_claims from the drifted roles.permissions column — saving "Admin"
        // silently took Administrator away from every space admin. Nobody had made a role of their own.
        static IResult Fixed(ICurrentUser current)
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            throw DomainException.BadRequest("roles are fixed: the space has Owner, Admin and Member; a server has its owner, Admin, Moderator and Member");
        }
        app.MapPost("/api/v1/roles", (ICurrentUser current) => Fixed(current));
        app.MapPatch("/api/v1/roles/{id:long}", (long id, ICurrentUser current) => Fixed(current));
        app.MapDelete("/api/v1/roles/{id:long}", (long id, ICurrentUser current) => Fixed(current));

        app.MapPost("/api/v1/users/{userId:long}/role", async (long userId, AssignRoleBody body, ICurrentUser current, ISender mediator,
            IConnectionRegistry registry) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new AssignRoleCommand(userId, body.RoleId, current.Permissions, current.UserId));
            // The space role is in every socket's permission snapshot (AdminEndpoints PATCH does the same).
            await registry.CloseUserAsync(userId);
            return Results.NoContent();
        });
    }
}
