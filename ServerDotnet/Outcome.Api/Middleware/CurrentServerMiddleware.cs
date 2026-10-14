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
        IServerRepository servers, IPermissionRepository permissions, IMemoryCache cache,
        Outcome.Infrastructure.Tenancy.ICurrentSpace space)
    {
        var ct = ctx.RequestAborted;
        // Every key below is scoped to the space. IMemoryCache is one instance for the whole
        // process, but each space is a separate database numbering its users and servers from 1 —
        // so "owner:1" or "mem:5:1" describes a different server and a different person in each of
        // them. Unscoped, this cache handed one space's membership, role and ownership answers to
        // another: exactly the checks below exist to prevent, defeated by their own cache.
        var spaceId = space.Space.Id;
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
                && await CachedAsync(cache, AuthCacheKeys.Member(spaceId, user.UserId, sid), LongTtl, () => servers.IsMemberAsync(sid, user.UserId, ct)))
            {
                serverId = sid;
            }
            else
            {
                var first = await CachedAsync(cache, AuthCacheKeys.FirstServer(spaceId, user.UserId), LongTtl, () => servers.GetFirstForUserAsync(user.UserId, ct));
                if (first > 0) serverId = first;
            }
        }
        current.Set(serverId);

        if (user.IsAuthenticated)
        {
            // The person's role INSIDE the active server (owner / admin / moderator / member) adds a
            // fixed server-scoped set, ServerRoles.Grant — the same set the socket computes through
            // IPermissionRepository.GetEffectiveForServerAsync, so REST and WS never disagree. The
            // space role and its claims stay exactly as JwtCurrentUserMiddleware loaded them.
            // Cached as a long (ServerRole) so "plain member" is cacheable too.
            var serverRole = (Outcome.Domain.Permissions.ServerRole)await CachedAsync(cache,
                AuthCacheKeys.MemberRole(spaceId, user.UserId, serverId), ShortTtl,
                async () => (long)await servers.GetServerRoleAsync(serverId, user.UserId, ct));
            user.GrantServerScope(Outcome.Domain.Permissions.ServerRoles.Grant(serverRole));
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
