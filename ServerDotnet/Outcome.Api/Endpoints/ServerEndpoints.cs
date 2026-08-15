using Microsoft.Extensions.Caching.Memory;
using Outcome.Api.Realtime;
using Outcome.Api.Security;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;
using Perm = Outcome.Domain.Permissions.Permission;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Endpoints;

public static class ServerEndpoints
{
    public sealed record CreateServerBody(string Name);
    public sealed record JoinServerBody(string Code);
    public sealed record AssignServerRoleBody(long? RoleId);
    public sealed record SetVisibilityBody(bool IsPublic, string? Description);
    public sealed record RenameServerBody(string Name);
    public sealed record SetDomainBody(string? Domain);

    private const int MaxServersPerUser = 3;

    // Accepts a plain FQDN host (no scheme/port/path); rejects IPs, single labels, junk.
    private static readonly System.Text.RegularExpressions.Regex DomainRe =
        new(@"^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$",
            System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>Normalize a user-entered custom domain to a bare lowercase host, or null if invalid
    /// (empty ⇒ null = "clear the domain"). Strips scheme, port, path and trailing dot.</summary>
    /// <summary>Shared with the admin endpoints, which set domains on spaces they don't own.</summary>
    public static string? NormalizeDomainPublic(string? raw) => NormalizeDomain(raw);

    private static string? NormalizeDomain(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var d = raw.Trim().ToLowerInvariant();
        if (d.Contains("://")) d = d[(d.IndexOf("://", StringComparison.Ordinal) + 3)..];
        d = d.Split('/')[0].Split('?')[0].Split(':')[0].TrimEnd('.'); // host only
        return DomainRe.IsMatch(d) ? d : "";  // "" signals "was provided but invalid"
    }

    public static void MapServerEndpoints(this IEndpointRouteBuilder app)
    {
        // Servers the current user belongs to (for the rail).
        app.MapGet("/api/v1/servers", async (ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var list = await servers.ListForUserAsync(current.UserId);
            return list.Select(s => new { id = s.Id, name = s.Name, owner_id = s.OwnerId, icon = s.Icon, custom_domain = s.CustomDomain }).ToArray();
        });

        // Create a server — limited to 3 per user; the creator becomes its owner + member.
        app.MapPost("/api/v1/servers", async (CreateServerBody body, ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var name = (body.Name ?? string.Empty).Trim();
            if (name.Length is 0 or > 64) throw DomainException.BadRequest("server name must be 1-64 characters");
            if (await servers.CountOwnedAsync(current.UserId) >= MaxServersPerUser)
                throw DomainException.BadRequest($"you can create at most {MaxServersPerUser} servers");
            var s = await servers.CreateAsync(name, current.UserId);
            return new { id = s.Id, name = s.Name, owner_id = s.OwnerId, icon = s.Icon };
        });

        // Join a server via an invite code (mandatory-invite membership).
        app.MapPost("/api/v1/servers/join", async (JoinServerBody body, ICurrentUser current, IServerRepository servers, IInviteRepository invites) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var code = (body.Code ?? string.Empty).Trim();
            var invite = await invites.GetByCodeAsync(code);
            if (invite is null || invite.Revoked
                || (invite.ExpiresAt is { } exp && exp <= DateTime.UtcNow)
                || (invite.MaxUses is { } max && invite.UseCount >= max))
                throw DomainException.BadRequest("invalid or expired invite");

            await servers.AddMemberAsync(invite.ServerId, current.UserId, null);
            await invites.ConsumeAsync(invite.Id, current.UserId);
            var s = await servers.GetAsync(invite.ServerId)
                    ?? throw DomainException.NotFound("server not found");
            return new { id = s.Id, name = s.Name, owner_id = s.OwnerId, icon = s.Icon };
        });

        // ── Public "Explore" directory ──────────────────────────────────────────
        // Public servers the user can discover + join without an invite.
        app.MapGet("/api/v1/servers/discover", async (ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var list = await servers.DiscoverAsync(current.UserId);
            return list.Select(s => new { id = s.Id, name = s.Name, description = s.Description, icon = s.Icon, member_count = s.MemberCount }).ToArray();
        });

        // Join a public server directly (no invite). 403 if the server isn't public.
        app.MapPost("/api/v1/servers/{id:long}/join-public", async (long id, ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var s = await servers.JoinPublicAsync(id, current.UserId)
                    ?? throw DomainException.Forbidden("this server is not public");
            return new { id = s.Id, name = s.Name, owner_id = s.OwnerId, icon = s.Icon };
        });

        // Owner reads / sets their server's discovery settings.
        app.MapGet("/api/v1/servers/{id:long}/visibility", async (long id, ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var info = await servers.GetAsync(id) ?? throw DomainException.NotFound("server not found");
            if (info.OwnerId != current.UserId) throw DomainException.Forbidden("only the owner can view this");
            var v = await servers.GetVisibilityAsync(id) ?? new ServerVisibility(false, "");
            return new { is_public = v.IsPublic, description = v.Description };
        });

        app.MapPatch("/api/v1/servers/{id:long}/visibility", async (long id, SetVisibilityBody body, ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (!await servers.SetVisibilityAsync(id, current.UserId, body.IsPublic, body.Description ?? ""))
                throw DomainException.Forbidden("only the server owner can change visibility");
            return Results.NoContent();
        });

        // Rename a server. Owner of it, an instance admin, or a ManageServer holder in it.
        app.MapPatch("/api/v1/servers/{id:long}", async (long id, RenameServerBody body, ICurrentUser current, ICurrentServer srv, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var info = await servers.GetAsync(id) ?? throw DomainException.NotFound("server not found");
            var isGlobalAdmin = (current.Permissions & Perm.Administrator) != 0;
            var canManage = info.OwnerId == current.UserId || isGlobalAdmin
                || (id == srv.ServerId && (current.Permissions & Perm.ManageServer) != 0);
            if (!canManage) throw DomainException.Forbidden("you can't manage this server");
            var name = (body.Name ?? string.Empty).Trim();
            if (name.Length is 0 or > 64) throw DomainException.BadRequest("server name must be 1-64 characters");
            if (!await servers.RenameAsync(id, name)) throw DomainException.NotFound("server not found");
            return Results.NoContent();
        });

        // Soft-delete a server (owner only) — kicks all members first.
        app.MapDelete("/api/v1/servers/{id:long}", async (long id, ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var ok = await servers.SoftDeleteAsync(id, current.UserId);
            if (!ok) throw DomainException.Forbidden("only the server owner can delete it");
            return Results.NoContent();
        });

        // Assign (or clear with null) a member's PER-SERVER role. The server owner or an instance admin
        // can assign any role; a per-server role manager (ManageRoles in the active server) can assign
        // Moderator/Member only. Per-server roles confer server-scoped perms only (instance-global powers
        // are stripped at resolution), so this can't hand out instance admin. The owner's role is fixed,
        // and the "Owner" role itself is never assignable.
        app.MapPost("/api/v1/servers/{serverId:long}/members/{userId:long}/role",
            async (long serverId, long userId, AssignServerRoleBody body, ICurrentUser current, ICurrentServer srv, IServerRepository servers, IMemoryCache cache, ICurrentSpace space) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var info = await servers.GetAsync(serverId) ?? throw DomainException.NotFound("server not found");
            var isOwner = info.OwnerId == current.UserId;
            var isGlobalAdmin = (current.Permissions & Perm.Administrator) != 0;
            var canManageRoles = isOwner || isGlobalAdmin
                || (serverId == srv.ServerId && (current.Permissions & Perm.ManageRoles) != 0);
            if (!canManageRoles)
                throw DomainException.Forbidden("you can't manage roles on this server");
            if (userId == info.OwnerId)
                throw DomainException.BadRequest("the server owner's role can't be changed");
            if (body.RoleId == Outcome.Domain.Permissions.DefaultRole.Owner)
                throw DomainException.BadRequest("the Owner role can't be assigned");
            // A non-owner role manager can't mint other admins (prevents server takeovers).
            if (!isOwner && !isGlobalAdmin && body.RoleId == Outcome.Domain.Permissions.DefaultRole.Admin)
                throw DomainException.Forbidden("only the server owner can grant the Admin role");
            if (!await servers.AssignMemberRoleAsync(serverId, userId, body.RoleId))
                throw DomainException.NotFound("member not found in this server");
            // Evict the middleware's cached role/permission entries so the change applies immediately.
            cache.Remove(AuthCacheKeys.MemberRole(space.Space.Id, userId, serverId));
            cache.Remove(AuthCacheKeys.Perm(space.Space.Id, userId, serverId));
            cache.Remove(AuthCacheKeys.Perm(space.Space.Id, userId));
            return Results.NoContent();
        });

        // Per-server kick: remove a member from THIS server (not a global ban). Allowed for the
        // server owner, an instance admin, or anyone with KickMembers in the active server. The
        // owner can't be kicked, and you can't kick yourself (use "leave server").
        app.MapDelete("/api/v1/servers/{serverId:long}/members/{userId:long}",
            async (long serverId, long userId, ICurrentUser current, ICurrentServer srv,
                   IServerRepository servers, IConnectionRegistry registry, IMemoryCache cache, ICurrentSpace space) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var info = await servers.GetAsync(serverId) ?? throw DomainException.NotFound("server not found");
            if (userId == info.OwnerId) throw DomainException.BadRequest("the server owner can't be removed");
            if (userId == current.UserId) throw DomainException.BadRequest("use 'leave server' to remove yourself");

            var isGlobalAdmin = (current.Permissions & Perm.Administrator) != 0;
            var canKick = info.OwnerId == current.UserId || isGlobalAdmin
                || (serverId == srv.ServerId && (current.Permissions & Perm.KickMembers) != 0);
            if (!canKick) throw DomainException.Forbidden("you can't remove members from this server");

            if (!await servers.RemoveMemberAsync(serverId, userId))
                throw DomainException.NotFound("member not found in this server");

            // Evict the removed user's membership/role/permission caches so access is revoked at once.
            cache.Remove(AuthCacheKeys.Member(space.Space.Id, userId, serverId));
            cache.Remove(AuthCacheKeys.FirstServer(space.Space.Id, userId));
            cache.Remove(AuthCacheKeys.MemberRole(space.Space.Id, userId, serverId));
            cache.Remove(AuthCacheKeys.Perm(space.Space.Id, userId, serverId));
            cache.Remove(AuthCacheKeys.Perm(space.Space.Id, userId));
            await registry.BroadcastToServerAsync(serverId, WsFrames.MemberLeave(userId));
            return Results.NoContent();
        });

        // ── Custom domain (per-space landing via Caddy on-demand TLS) ────────────
        // Owner CNAMEs chat.theircommunity.com → us and sets it here.
        // TODO: gate behind a paid plan once billing lands.
        app.MapPut("/api/v1/servers/{id:long}/domain", async (long id, SetDomainBody body, ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var info = await servers.GetAsync(id) ?? throw DomainException.NotFound("server not found");
            if (info.OwnerId != current.UserId) throw DomainException.Forbidden("only the owner can set the domain");
            var domain = NormalizeDomain(body.Domain);
            if (string.IsNullOrEmpty(domain)) throw DomainException.BadRequest("enter a valid domain like chat.example.com");
            var taken = await servers.FindByCustomDomainAsync(domain);
            if (taken is not null && taken.Id != id) throw DomainException.Conflict("this domain is already in use");
            if (!await servers.SetCustomDomainAsync(id, current.UserId, domain))
                throw DomainException.NotFound("server not found");
            return new { custom_domain = domain };
        });

        app.MapDelete("/api/v1/servers/{id:long}/domain", async (long id, ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (!await servers.SetCustomDomainAsync(id, current.UserId, null))
                throw DomainException.Forbidden("only the owner can clear the domain");
            return Results.NoContent();
        });

        // Public: which space (if any) owns the host the browser loaded. The SPA calls this on
        // boot to default the active space when opened on a custom domain.
        // What this host is: the space's name and logo, for the login screen (which has no
        // session yet). Unauthenticated on purpose.
        app.MapGet("/api/v1/space-by-host", async (ICurrentSpace here, ISettingsRepository settings, CancellationToken ct) =>
        {
            var name = await settings.GetAsync("server_name", ct);
            var icon = await settings.GetAsync("server_icon", ct);
            return Results.Ok(new
            {
                space_id = here.Space.Id,
                slug = here.Space.Slug,
                name = string.IsNullOrWhiteSpace(name) ? here.Space.Name : name,
                icon = string.IsNullOrWhiteSpace(icon) ? null : icon,
                is_root = here.Space.IsRoot,
            });
        });

        // Caddy on-demand-TLS "ask": mint a cert only for domains we actually serve. 200 = allow.
        app.MapGet("/api/v1/tls-check", async (string? domain, ISpaceRegistry spaces, CancellationToken ct) =>
        {
            var d = NormalizeDomain(domain);
            if (string.IsNullOrEmpty(d)) return Results.StatusCode(400);
            var claimed = (await spaces.ListAsync(ct)).Any(x => x.Active && x.Domain == d);
            return claimed ? Results.Ok() : Results.StatusCode(403);
        });
    }
}
