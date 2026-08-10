using MediatR;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Users;
using Outcome.Domain.Errors;

namespace Outcome.Api.Endpoints;

public static class UserEndpoints
{
    public sealed record UpdateProfileBody(string? Username, string? Avatar, string? PublicKey, string? E2eeBackup, bool? PushPreview);
    public sealed record ChangePasswordBody(string CurrentPassword, string NewPassword);

    public static void MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/users/me", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new GetMyProfileQuery(current.UserId));
        });

        // Directory search: match by username or email (case-insensitive, min 2 chars, excludes self).
        app.MapGet("/api/v1/users/search", async (string? q, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new SearchUsersQuery(q ?? "", current.UserId));
        });

        // Claim-based effective permissions (role_claims UNION user_claims), like api_mobstra_analytics.
        app.MapGet("/api/v1/users/me/permissions", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new GetMyPermissionsQuery(current.UserId));
        });

        app.MapPatch("/api/v1/users/me", async (UpdateProfileBody body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new UpdateProfileCommand(current.UserId, body.Username, body.Avatar, body.PublicKey, body.E2eeBackup, body.PushPreview));
        });

        app.MapPut("/api/v1/users/me/password", async (ChangePasswordBody body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new ChangePasswordCommand(current.UserId, body.CurrentPassword, body.NewPassword));
            return Results.NoContent();
        });

        app.MapGet("/api/v1/users/me/sessions", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new ListSessionsQuery(current.UserId));
        });

        app.MapDelete("/api/v1/users/me/sessions/{id:long}", async (long id, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new RevokeSessionCommand(current.UserId, id));
            return Results.NoContent();
        });

        // "Sign out everywhere else" — revokes every session except the calling one.
        app.MapDelete("/api/v1/users/me/sessions", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new RevokeAllSessionsCommand(current.UserId));
        });
    }
}
