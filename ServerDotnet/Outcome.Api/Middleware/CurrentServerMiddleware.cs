using Microsoft.Extensions.Caching.Memory;
using Outcome.Api.Security;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Security;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;

namespace Outcome.Api.Middleware;

/// <summary>
/// Resolves the active server (tenant) for the request from the <c>X-Server-Id</c> header,
/// falling back to the authenticated user's primary membership (or server 1). Runs after
/// <see cref="JwtCurrentUserMiddleware"/> so the current user is known. Membership / role /
/// owner lookups are memory-cached for a few seconds — without the cache every authenticated
/// request paid 4-6 extra DB round-trips here.
/// </summary>
public sealed class CurrentServerMiddleware(RequestDelegate next)
{
    private static readonly TimeSpan ShortTtl = TimeSpan.FromSeconds(10);   // role/permission data
    private static readonly TimeSpan LongTtl = TimeSpan.FromSeconds(30);    // membership/ownership (changes rarely)

    public async Task Invoke(
        HttpContext ctx, CurrentServerContext current, CurrentUserContext user,
        IServerRepository servers, IPermissionRepository permissions, IMemoryCache cache)
    {
        var ct = ctx.RequestAborted;
        long serverId = 1;   // unauthenticated default (public endpoints don't scope to a tenant)
        if (user.IsAuthenticated)
        {
            // Authenticated users get a tenant ONLY through membership. A user who belongs to no server
            // (e.g. just registered without an invite) resolves to 0 — no tenant — so tenant-scoped
            // endpoints return nothing rather than leaking the default server's content.
            serverId = 0;
            var header = ctx.Request.Headers["X-Server-Id"].FirstOrDefault();
            // Only honor the requested tenant if the user is actually a MEMBER of it — otherwise a
            // spoofed X-Server-Id would let a non-member act inside someone else's server. Mirrors
            // the WebSocket auth path. Fall back to the user's primary membership.
            if (long.TryParse(header, out var sid) && sid > 0
                && await CachedAsync(cache, $"mem:{user.UserId}:{sid}", LongTtl, () => servers.IsMemberAsync(sid, user.UserId, ct)))
            {
                serverId = sid;
            }
            else
            {
                var first = await CachedAsync(cache, $"first:{user.UserId}", LongTtl, () => servers.GetFirstForUserAsync(user.UserId, ct));
                if (first > 0) serverId = first;
            }
        }
        current.Set(serverId);

        if (user.IsAuthenticated)
        {
            // Per-server role: if the user has a role assigned in THIS server (server_members.role_id) that
            // differs from their global role, re-resolve their permissions for the active server (adds the
            // per-server role's server-scoped perms; instance-global perms still come only from the global
            // role). No assignment → JwtCurrentUserMiddleware's global perms stand (unchanged behavior).
            // Cached as a plain long with 0 = "no per-server assignment" so the common no-role
            // case is cacheable too (a null result would bypass the cache every request).
            var memberRole = await CachedAsync(cache, $"mrole:{user.UserId}:{serverId}", ShortTtl,
                async () => await servers.GetMemberRoleAsync(serverId, user.UserId, ct) ?? 0L);
            if (memberRole is var psr && psr != 0 && psr != user.RoleId)
            {
                var names = await CachedAsync(cache, $"perm:{user.UserId}:{serverId}", ShortTtl,
                    () => permissions.GetEffectiveForServerAsync(user.UserId, serverId, ct));
                user.Set(user.UserId, psr, Perms.ToBits(names), names, user.SessionTokenHash ?? string.Empty);
            }

            // The owner of the active server is an admin WITHIN it (server-scoped manage perms only — not
            // the global Administrator bypass). Skip if already a global admin.
            if ((user.Permissions & Outcome.Domain.Permissions.Permission.Administrator) == 0)
            {
                var ownerId = await CachedAsync(cache, $"owner:{serverId}", LongTtl, async () =>
                {
                    var info = await servers.GetAsync(serverId, ct);
                    return info?.OwnerId ?? 0L;
                });
                if (ownerId == user.UserId)
                    user.GrantServerAdmin();
            }
        }

        await next(ctx);
    }

    private static async Task<T> CachedAsync<T>(IMemoryCache cache, string key, TimeSpan ttl, Func<Task<T>> load)
    {
        if (cache.TryGetValue(key, out T? hit) && hit is not null) return hit;
        var value = await load();
        if (value is not null) cache.Set(key, value, ttl);
        return value!;
    }
}
