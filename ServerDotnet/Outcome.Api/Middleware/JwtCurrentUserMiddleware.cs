using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.Extensions.Caching.Memory;
using Outcome.Api.Http;
using Outcome.Api.Security;
using Outcome.Shared.Abstractions.Authorization;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;

namespace Outcome.Api.Middleware;

/// <summary>
/// Runs after <c>UseAuthentication</c> (JWT bearer). If the request carries a valid token,
/// resolves the user id from the <c>nameid</c> claim, loads the user + role, verifies the
/// token's SESSION still exists (logout / admin kick delete sessions → token revoked even
/// though the JWT itself is still cryptographically valid), and populates
/// <see cref="CurrentUserContext"/>. Permissions are looked up fresh (not read from the
/// token) so role changes apply immediately; both the session check and the permission
/// resolve are memory-cached for a few seconds so they don't add DB round-trips to every
/// request. Banned users are rejected with 403. Requests without a valid token simply
/// continue unauthenticated — endpoints enforce auth themselves.
/// </summary>
public sealed class JwtCurrentUserMiddleware(RequestDelegate next)
{
    /// <summary>How long cached session-validity / permission entries live. Revocations and
    /// role edits fully propagate within this window.</summary>
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(10);

    public async Task Invoke(
        HttpContext ctx,
        Outcome.Infrastructure.Tenancy.ICurrentSpace space,
        CurrentUserContext current,
        IUserRepository users,
        IPermissionRepository permissions,
        ISessionRepository sessions,
        IMemoryCache cache)
    {
        if (ctx.User.Identity?.IsAuthenticated == true)
        {
            // The bearer pipeline only checked the signature. A token signed by this instance
            // is still the wrong token if it was minted for another space — same key, different
            // people behind the same ids.
            if (Outcome.Api.Jwt.JwtTokenService.SpaceOf(ctx.User) != space.Space.Id)
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await ctx.Response.WriteAsJsonAsync(new ErrorEnvelope("UNAUTHORIZED", "this session belongs to another space"));
                return;
            }

            var idClaim = ctx.User.FindFirst(JwtRegisteredClaimNames.NameId)?.Value
                          ?? ctx.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
                          ?? ctx.User.FindFirst("nameid")?.Value;

            if (long.TryParse(idClaim, out var userId))
            {
                var user = await users.GetByIdAsync(userId, ctx.RequestAborted);
                if (user is not null)
                {
                    if (user.Deleted)
                    {
                        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                        await ctx.Response.WriteAsJsonAsync(new ErrorEnvelope("UNAUTHORIZED", "your account has been deleted"));
                        return;
                    }
                    if (user.Banned && (user.BanExpires is null || user.BanExpires > DateTime.UtcNow))
                    {
                        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                        await ctx.Response.WriteAsJsonAsync(new ErrorEnvelope("FORBIDDEN", "your account has been suspended"));
                        return;
                    }

                    // Session revocation check: the bearer token must map to a live session row.
                    var tokenHash = ExtractTokenHash(ctx);
                    if (tokenHash is null || !await SessionAliveAsync(sessions, cache, tokenHash, ctx.RequestAborted))
                    {
                        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                        await ctx.Response.WriteAsJsonAsync(new ErrorEnvelope("UNAUTHORIZED", "session expired or revoked"));
                        return;
                    }

                    // Permissions are claim-based (role_claims ∪ user_claims); the int64 bitfield
                    // exposed on ICurrentUser is derived from those claims for the override math.
                    if (!cache.TryGetValue($"perm:{user.Id}", out IReadOnlyList<string>? permNames) || permNames is null)
                    {
                        permNames = await permissions.GetEffectiveAsync(user.Id, ctx.RequestAborted);
                        cache.Set($"perm:{user.Id}", permNames, CacheTtl);
                    }
                    current.Set(user.Id, user.RoleId, Permissions.ToBits(permNames), permNames, tokenHash);
                }
            }
        }

        await next(ctx);
    }

    private static string? ExtractTokenHash(HttpContext ctx)
    {
        var header = ctx.Request.Headers.Authorization.FirstOrDefault();
        if (header is null || !header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
        var raw = header["Bearer ".Length..].Trim();
        return raw.Length == 0 ? null : TokenHash.Sha256(raw);
    }

    private static async Task<bool> SessionAliveAsync(
        ISessionRepository sessions, IMemoryCache cache, string tokenHash, CancellationToken ct)
    {
        var key = "sess:" + tokenHash;
        if (cache.TryGetValue(key, out bool alive)) return alive;

        var session = await sessions.GetByTokenHashAsync(tokenHash, ct);
        alive = session is not null && session.ExpiresAt > DateTime.UtcNow;
        if (alive)
        {
            // Touch LastUsed at most once per cache window (not on every request).
            await sessions.UpdateLastUsedAsync(tokenHash, DateTime.UtcNow, ct);
            cache.Set(key, true, CacheTtl);
        }
        return alive;
    }
}
