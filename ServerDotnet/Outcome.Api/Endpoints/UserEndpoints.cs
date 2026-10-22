using MediatR;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Users;
using Outcome.Domain.Errors;
using Outcome.Shared.Legal;

namespace Outcome.Api.Endpoints;

public static class UserEndpoints
{
    public sealed record UpdateProfileBody(string? Username, string? Avatar, bool? PushPreview);
    public sealed record ChangePasswordBody(string CurrentPassword, string NewPassword);
    public sealed record ConsentBody(string ConsentVersion);

    public static void MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/users/me", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new GetMyProfileQuery(current.UserId));
        });

        // Directory search: a username by any part, an e-mail only whole (case-insensitive, min 2
        // chars, excludes self). Metered per person: each answer says who matches a string.
        app.MapGet("/api/v1/users/search", async (string? q, ICurrentUser current, ISender mediator,
            IRateLimiter limiter, Outcome.Infrastructure.Tenancy.ICurrentSpace space) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (!limiter.Allow($"user_search:{space.Space.Id}:{current.UserId}", 60, TimeSpan.FromMinutes(1)))
                throw new DomainException("RATE_LIMITED", 429, "too many searches");
            return await mediator.Send(new SearchUsersQuery(q ?? "", current.UserId));
        });

        // Claim-based effective permissions (role_claims UNION user_claims), like api_mobstra_analytics.
        app.MapGet("/api/v1/users/me/permissions", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new GetMyPermissionsQuery(current.UserId));
        });

        app.MapPatch("/api/v1/users/me", async (UpdateProfileBody body, ICurrentUser current, ISender mediator,
            Outcome.Shared.Abstractions.Persistence.IAttachmentRepository attachments, Outcome.Shared.Abstractions.Persistence.IUserRepository users) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (body.Avatar is { Length: > 0 } avatar)
                await PictureRules.RequireOwnPictureAsync(avatar, current.UserId, attachments,
                    (await users.GetByIdAsync(current.UserId))?.Avatar, allowDataUri: true);
            return await mediator.Send(new UpdateProfileCommand(current.UserId, body.Username, body.Avatar, body.PushPreview));
        });

        app.MapPut("/api/v1/users/me/password", async (ChangePasswordBody body, ICurrentUser current, ISender mediator,
            Outcome.Infrastructure.Tenancy.ICurrentSpace space, Outcome.Api.Realtime.SessionRevocations revocations) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new ChangePasswordCommand(current.UserId, body.CurrentPassword, body.NewPassword));
            revocations.Revoked(space.Space.Id, current.UserId);
            return Results.NoContent();
        });

        // Its own endpoint, not a field on something else: folding it into another call would
        // bundle consent with another action, which is the exact shape 156-ФЗ set out to stop.
        //
        // Write-once: a second call cannot move the date or the version. What is recorded is
        // when this person first agreed and to which text, and that is not a thing later
        // activity gets to rewrite.
        app.MapPost("/api/v1/users/me/consent", async (ConsentBody body, ICurrentUser current, IUserRepository users) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var version = string.IsNullOrWhiteSpace(body.ConsentVersion)
                ? PdnConsent.Version : body.ConsentVersion;
            await users.RecordConsentAsync(current.UserId, version);
            return Results.NoContent();
        });

        app.MapGet("/api/v1/users/me/sessions", async (ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new ListSessionsQuery(current.UserId));
        });

        app.MapDelete("/api/v1/users/me/sessions/{id:long}", async (long id, ICurrentUser current, ISender mediator,
            Outcome.Infrastructure.Tenancy.ICurrentSpace space, Outcome.Api.Realtime.SessionRevocations revocations) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new RevokeSessionCommand(current.UserId, id));
            // Every socket of the user re-checks its own session; only the revoked one closes.
            revocations.Revoked(space.Space.Id, current.UserId);
            return Results.NoContent();
        });

        // "Sign out everywhere else" — revokes every session except the calling one.
        app.MapDelete("/api/v1/users/me/sessions", async (ICurrentUser current, ISender mediator,
            Outcome.Infrastructure.Tenancy.ICurrentSpace space, Outcome.Api.Realtime.SessionRevocations revocations) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var result = await mediator.Send(new RevokeAllSessionsCommand(current.UserId));
            revocations.Revoked(space.Space.Id, current.UserId);
            return result;
        });
    }
}

/// <summary>What a profile picture or a server icon may be: our own upload of the person setting it,
/// not yet posted anywhere — or, for an avatar, an inline raster data: URI. Anything else is refused.
/// An avatar used to take any string: a link to another host made every viewer's client fetch it
/// (a pixel that sees everyone who looks at the profile), and another person's attachment path
/// turned that file into one the file endpoint serves to anyone, unsigned and forever (the
/// avatar/icon exemption). The value already stored is accepted unchanged, so saving a profile
/// form that did not touch the picture never fails.</summary>
internal static class PictureRules
{
    private const string FilePrefix = "/api/v1/files/";
    private static readonly string[] DataPrefixes = ["data:image/png", "data:image/jpeg", "data:image/gif", "data:image/webp"];

    public static async Task RequireOwnPictureAsync(string value, long userId,
        Outcome.Shared.Abstractions.Persistence.IAttachmentRepository attachments, string? current, bool allowDataUri)
    {
        if (allowDataUri && DataPrefixes.Any(p => value.StartsWith(p, StringComparison.OrdinalIgnoreCase))) return;
        if (!value.StartsWith(FilePrefix, StringComparison.Ordinal))
            throw DomainException.BadRequest("the picture must be uploaded here");
        var bare = value.IndexOf('?') is var q && q > 0 ? value[..q] : value;
        if (current is not null && bare == current) return;
        var att = await attachments.GetByIdAsync(bare[FilePrefix.Length..]);
        if (att is null || att.UploaderId != userId || att.MessageId is not null)
            throw DomainException.BadRequest("the picture must be a file you uploaded for it");
    }
}

