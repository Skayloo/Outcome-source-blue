using MediatR;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Api.Http;
using Outcome.Api.Realtime;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Security;
using Outcome.Application.Auth;
using Outcome.Domain.Errors;
using Outcome.Shared.Abstractions.Persistence;

namespace Outcome.Api.Endpoints;

public static class AuthEndpoints
{
    // ConsentVersion is OPTIONAL on purpose. Making it required would reject every client built
    // before it existed — including the build sitting in RuStore moderation right now. Absent,
    // the server records its own current version, which is the truthful reading of "whatever
    // was published when this account was made".
    public sealed record RegisterBody(string Email, string Username, string Password, string InviteCode, string? ConsentVersion = null);
    public sealed record LoginBody(string Email, string Password);
    public sealed record VerifyTotpBody(string Code);
    public sealed record PasswordBody(string Password);
    public sealed record ConfirmTotpBody(string Password, string Code);

    /// <summary>The space that owns the domain this request came in on, if any.</summary>
    private static async Task<long?> HostSpaceIdAsync(HttpContext ctx, IServerRepository servers)
    {
        var host = ctx.Request.Host.Host?.ToLowerInvariant();
        if (string.IsNullOrEmpty(host)) return null;
        return (await servers.FindByCustomDomainAsync(host, ctx.RequestAborted))?.Id;
    }

    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/auth");

        group.MapPost("/register", async (RegisterBody body, HttpContext ctx, ISender mediator, IServerRepository servers) =>
        {
            var result = await mediator.Send(new RegisterUserCommand(
                body.Email, body.Username, body.Password, body.InviteCode,
                ctx.Request.Headers.UserAgent.ToString(), ClientIp(ctx),
                await HostSpaceIdAsync(ctx, servers), body.ConsentVersion));
            return result;
        }).AddEndpointFilter(RateLimit("register", 3, TimeSpan.FromMinutes(1)))
          .AddEndpointFilter(GlobalRateLimit("register", 600, TimeSpan.FromMinutes(1)));

        group.MapPost("/login", async (LoginBody body, HttpContext ctx, ISender mediator) =>
            await mediator.Send(new LoginCommand(
                body.Email, body.Password,
                ctx.Request.Headers.UserAgent.ToString(), ClientIp(ctx))))
            .AddEndpointFilter(RateLimit("login", 60, TimeSpan.FromMinutes(1)))
            .AddEndpointFilter(GlobalRateLimit("login", 1200, TimeSpan.FromMinutes(1)));

        group.MapPost("/logout", async (ISender mediator, ICurrentUser current, Outcome.Infrastructure.Tenancy.ICurrentSpace space, SessionRevocations revocations) =>
        {
            var uid = current.IsAuthenticated ? current.UserId : 0;
            await mediator.Send(new LogoutCommand());
            // The socket of the session just ended goes now, not at its next minute's re-check.
            if (uid > 0) revocations.Revoked(space.Space.Id, uid);
            return Results.NoContent();
        });

        group.MapGet("/me", async (ISender mediator) => await mediator.Send(new GetMeQuery()));

        // POST /api/v1/auth/verify-totp — partial token in Authorization header, { code } in body.
        group.MapPost("/verify-totp", async (VerifyTotpBody body, HttpContext ctx, ISender mediator) =>
        {
            var partial = ExtractBearer(ctx.Request.Headers.Authorization.ToString())
                          ?? throw DomainException.Unauthorized("missing or invalid authorization header");
            var result = await mediator.Send(new VerifyTotpCommand(partial, body.Code));
            return result;
        }).AddEndpointFilter(RateLimit("verify_totp", 10, TimeSpan.FromMinutes(1)));

        // DELETE /api/v1/auth/account — password-confirmed self-deletion (soft delete).
        group.MapDelete("/account", async ([Microsoft.AspNetCore.Mvc.FromBody] PasswordBody body, ICurrentUser current, IConnectionRegistry registry, VoiceEviction voice, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var uid = current.UserId;
            await mediator.Send(new DeleteAccountCommand(uid, body.Password));
            // Tell every client to drop this member and mark their messages as deleted.
            await registry.BroadcastAsync(WsFrames.MemberDelete(uid));
            // …and close the account's own sockets: they were authenticated as a user who is gone.
            await registry.CloseUserAsync(uid);
            await voice.EvictUserAsync(uid);
            return Results.NoContent();
        }).AddEndpointFilter(RateLimit("delete_account", 5, TimeSpan.FromMinutes(1)));

        // ── TOTP 2FA enrollment (authenticated) ──────────────────────────────
        app.MapPost("/api/v1/users/me/totp/enable", async (PasswordBody body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            return await mediator.Send(new EnableTotpCommand(current.UserId, body.Password));
        }).AddEndpointFilter(RateLimit("totp_enable", 5, TimeSpan.FromMinutes(1)));

        app.MapPost("/api/v1/users/me/totp/confirm", async (ConfirmTotpBody body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new ConfirmTotpCommand(current.UserId, body.Password, body.Code));
            return Results.NoContent();
        }).AddEndpointFilter(RateLimit("totp_confirm", 5, TimeSpan.FromMinutes(1)));

        app.MapDelete("/api/v1/users/me/totp", async ([Microsoft.AspNetCore.Mvc.FromBody] PasswordBody? body, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new DisableTotpCommand(current.UserId, body?.Password ?? string.Empty));
            return Results.NoContent();
        }).AddEndpointFilter(RateLimit("totp_disable", 5, TimeSpan.FromMinutes(1)));
    }

    private static string? ExtractBearer(string? header)
    {
        if (string.IsNullOrEmpty(header)) return null;
        var parts = header.Split(' ', 2, StringSplitOptions.TrimEntries);
        return parts.Length == 2 && parts[0].Equals("bearer", StringComparison.OrdinalIgnoreCase) && parts[1].Length > 0
            ? parts[1]
            : null;
    }

    internal static string ClientIp(HttpContext ctx) =>
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    private static Func<EndpointFilterInvocationContext, EndpointFilterDelegate, ValueTask<object?>> RateLimit(
        string prefix, int limit, TimeSpan window) =>
        async (ctx, next) =>
        {
            var limiter = ctx.HttpContext.RequestServices.GetRequiredService<IRateLimiter>();
            if (!ClientRate.Allow(limiter, ctx.HttpContext, prefix, limit, window))
                return Results.Json(
                    new ErrorEnvelope("RATE_LIMITED", "too many requests, please slow down"),
                    statusCode: StatusCodes.Status429TooManyRequests);
            return await next(ctx);
        };

    /// <summary>Instance-wide ceiling keyed WITHOUT the client IP. The per-IP filter stops a
    /// single abuser; this one stops a botnet from saturating Argon2 hashing (each register/login
    /// attempt burns real CPU). Limits sit far above any legitimate launch-day peak, so tripping
    /// one means the instance is under attack — 429 is the right answer for everyone briefly.</summary>
    private static Func<EndpointFilterInvocationContext, EndpointFilterDelegate, ValueTask<object?>> GlobalRateLimit(
        string name, int limit, TimeSpan window) =>
        async (ctx, next) =>
        {
            var limiter = ctx.HttpContext.RequestServices.GetRequiredService<IRateLimiter>();
            if (!limiter.Allow($"global:{name}", limit, window))
                return Results.Json(
                    new ErrorEnvelope("RATE_LIMITED", "the server is receiving too many requests right now, please retry shortly"),
                    statusCode: StatusCodes.Status429TooManyRequests);
            return await next(ctx);
        };
}
