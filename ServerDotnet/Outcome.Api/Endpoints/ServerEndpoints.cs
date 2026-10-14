using Microsoft.Extensions.Caching.Memory;
using Outcome.Api.Realtime;
using Outcome.Api.Security;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Security;
using Outcome.Domain.Errors;
using Perm = Outcome.Domain.Permissions.Permission;
using Outcome.Domain.Permissions;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Endpoints;

public static class ServerEndpoints
{
    public sealed record CreateServerBody(string Name);
    public sealed record JoinServerBody(string Code);
    /// <summary><c>role</c> = "admin" | "moderator" | "member"; the older clients' <c>role_id</c>
    /// (2 = Admin, 3 = Moderator, null/4 = Member) is still understood.</summary>
    public sealed record AssignServerRoleBody(long? RoleId, string? Role = null);
    public sealed record SetVisibilityBody(bool IsPublic, string? Description);
    /// <summary>Rename and/or set the picture. Icon null = leave it alone, empty = remove it —
    /// a record cannot tell "absent" from "null", so empty string is how you clear it.</summary>
    public sealed record RenameServerBody(string Name, string? Icon = null);
    public sealed record SetDomainBody(string? Domain);

    private const int MaxServersPerUser = 3;

    /// <summary>The caller's standing for MANAGING a server: their role in it, or Admin for the space's
    /// Administrator, who runs any server from /admin without having to join it (and so without
    /// reading it). Admin and Owner manage; nothing here is decided by a permission bit — the bits
    /// a server role carries are kept to what server-scoped handlers need (ServerRoles.Grant).</summary>
    private static async Task<ServerRole> ManagerRoleAsync(long serverId, ICurrentUser current, IServerRepository servers)
    {
        var role = await servers.GetServerRoleAsync(serverId, current.UserId);
        if (role != ServerRole.Owner && (current.Permissions & Perm.Administrator) != 0) return ServerRole.Admin;
        return role;
    }

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
            _ = await servers.GetAsync(id) ?? throw DomainException.NotFound("server not found");
            if (!ServerRoles.CanManage(await ManagerRoleAsync(id, current, servers)))
                throw DomainException.Forbidden("only the server's owner or admins can view this");
            var v = await servers.GetVisibilityAsync(id) ?? new ServerVisibility(false, "");
            return new { is_public = v.IsPublic, description = v.Description };
        });

        app.MapPatch("/api/v1/servers/{id:long}/visibility", async (long id, SetVisibilityBody body, ICurrentUser current, IServerRepository servers) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var info = await servers.GetAsync(id) ?? throw DomainException.NotFound("server not found");
            if (!ServerRoles.CanManage(await ManagerRoleAsync(id, current, servers)))
                throw DomainException.Forbidden("only the server's owner or admins can change visibility");
            if (!await servers.SetVisibilityAsync(id, info.OwnerId, body.IsPublic, body.Description ?? ""))
                throw DomainException.NotFound("server not found");
            return Results.NoContent();
        });

        // Rename a server / set its picture: its owner, its admins, or the space's Administrator.
        app.MapPatch("/api/v1/servers/{id:long}", async (long id, RenameServerBody body, ICurrentUser current, IServerRepository servers,
            IAttachmentRepository attachments) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var server = await servers.GetAsync(id) ?? throw DomainException.NotFound("server not found");
            if (!ServerRoles.CanManage(await ManagerRoleAsync(id, current, servers)))
                throw DomainException.Forbidden("you can't manage this server");
            var name = (body.Name ?? string.Empty).Trim();
            if (name.Length is 0 or > 64) throw DomainException.BadRequest("server name must be 1-64 characters");
            if (!await servers.RenameAsync(id, name)) throw DomainException.NotFound("server not found");

            // The column, the DTOs and both clients have carried an icon since the beginning;
            // nothing could ever write one, so every server has shown two letters of its name.
            if (body.Icon is { } raw)
            {
                var icon = raw.Trim();
                // Our own uploads only. An arbitrary URL here would be fetched by every client
                // that renders the server list — a pixel that sees everyone who opens the app.
                if (icon.Length > 0 && !icon.StartsWith("/api/v1/files/", StringComparison.Ordinal))
                    throw DomainException.BadRequest("icon must be an uploaded file");
                // …and the picture of the person setting it (see PictureRules: any attachment path
                // made that file public, unsigned and for good).
                if (icon.Length > 0)
                    await PictureRules.RequireOwnPictureAsync(icon, current.UserId, attachments, server.Icon, allowDataUri: false);
                await servers.SetIconAsync(id, icon.Length == 0 ? null : icon);
            }
            return Results.NoContent();
        });

        // Soft-delete a server (owner only) — kicks all members first.
        app.MapDelete("/api/v1/servers/{id:long}", async (long id, ICurrentUser current, IServerRepository servers, VoiceEviction voice,
                IConnectionRegistry registry) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var ok = await servers.SoftDeleteAsync(id, current.UserId);
            if (!ok) throw DomainException.Forbidden("only the server owner can delete it");
            // Its rooms go with it — the people in them were still talking in a server that is gone.
            await voice.EvictServerAsync(id);
            // Sockets still tagged with it kept posting into its channels and receiving each other's
            // lines; the reconnect lands them on a server they still belong to.
            await registry.CloseOnServerAsync(id);
            return Results.NoContent();
        });

        // A member's role INSIDE this server: Admin, Moderator or Member. Set by the server's owner, its
        // admins, or the space's Administrator. The owner is servers.owner_id and is never changed here.
        // Server roles grant server-scoped things only (ServerRoles.Grant + the explicit checks on these
        // routes), so nothing assigned here reaches the space.
        app.MapPost("/api/v1/servers/{serverId:long}/members/{userId:long}/role",
            async (long serverId, long userId, AssignServerRoleBody body, ICurrentUser current, IServerRepository servers,
                   IConnectionRegistry registry, IMemoryCache cache, ICurrentSpace space, IRateLimiter limiter) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var info = await servers.GetAsync(serverId) ?? throw DomainException.NotFound("server not found");
            if (!ServerRoles.CanManage(await ManagerRoleAsync(serverId, current, servers)))
                throw DomainException.Forbidden("you can't manage roles on this server");
            if (userId == info.OwnerId)
                throw DomainException.BadRequest("the server owner's role can't be changed");
            ServerRole newRole;
            if (body.Role is { } name)
            {
                if (!ServerRoles.TryParse(name, out newRole)) throw DomainException.BadRequest("role must be admin, moderator or member");
            }
            else
            {
                newRole = body.RoleId switch
                {
                    null or DefaultRole.Member => ServerRole.Member,
                    DefaultRole.Admin => ServerRole.Admin,
                    DefaultRole.Moderator => ServerRole.Moderator,
                    _ => throw DomainException.BadRequest("role must be admin, moderator or member"),
                };
            }
            if (!await servers.IsMemberAsync(serverId, userId))
                throw DomainException.NotFound("member not found in this server");
            // Re-posting the role a member already has changed nothing, yet closed every socket they had:
            // one request a second kept someone offline across the whole space.
            if (await servers.GetServerRoleAsync(serverId, userId) == newRole) return Results.NoContent();
            // Alternating two roles is a real change each time — so the change itself is limited.
            if (!limiter.Allow($"server-role:{space.Space.Id}:{serverId}:{userId}", 6, TimeSpan.FromMinutes(10)))
                throw DomainException.RateLimited("this member's role was changed too often — try again later");
            if (!await servers.AssignMemberRoleAsync(serverId, userId, ServerRoles.StoredRoleId(newRole)))
                throw DomainException.NotFound("member not found in this server");
            // Evict the middleware's cached role/permission entries so the change applies immediately.
            cache.Remove(AuthCacheKeys.MemberRole(space.Space.Id, userId, serverId));
            cache.Remove(AuthCacheKeys.Perm(space.Space.Id, userId, serverId));
            cache.Remove(AuthCacheKeys.Perm(space.Space.Id, userId));
            // Rosters show the role in this server — tell everyone looking at it.
            await registry.BroadcastToServerAsync(serverId, WsFrames.MemberUpdate(userId, ServerRoles.Name(newRole)));
            // The socket holds the role and permissions it authenticated with; a demoted admin kept
            // using them over it until they happened to reconnect. Closing makes the client
            // reconnect at once (a call survives: the re-join keeps its media) with the new role.
            // Only the sockets looking at THIS server hold its role — the others are left alone.
            await registry.CloseOnServerAsync(serverId, userId);
            return Results.NoContent();
        });

        // Per-server kick: remove a member from THIS server (not a global ban). The owner and the
        // server's admins (and the space's Administrator) remove anyone but the owner; a moderator
        // removes plain members only. You can't kick yourself (use "leave server").
        app.MapDelete("/api/v1/servers/{serverId:long}/members/{userId:long}",
            async (long serverId, long userId, ICurrentUser current, ICurrentServer srv,
                   IServerRepository servers, IConnectionRegistry registry, IMemoryCache cache, ICurrentSpace space, VoiceEviction voice) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var info = await servers.GetAsync(serverId) ?? throw DomainException.NotFound("server not found");
            if (userId == info.OwnerId) throw DomainException.BadRequest("the server owner can't be removed");
            if (userId == current.UserId) throw DomainException.BadRequest("use 'leave server' to remove yourself");

            var actor = await ManagerRoleAsync(serverId, current, servers);
            var canKick = ServerRoles.CanManage(actor)
                || (actor == ServerRole.Moderator && await servers.GetServerRoleAsync(serverId, userId) == ServerRole.Member);
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
            // Out of this server's call, and off its live traffic: a socket whose active server
            // is this one went on receiving every message posted in it. The reconnect lands
            // them on a server they still belong to.
            await voice.EvictUserAsync(userId, onlyServerId: serverId);
            await registry.CloseUserAsync(userId);
            return Results.NoContent();
        });

        // ── Custom domain (per-space landing via Caddy on-demand TLS) ────────────
        // Owner CNAMEs chat.theircommunity.com → us and sets it here.
        // TODO: gate behind a paid plan once billing lands.
        // The space's Administrator only (and the server's owner): registration on a host puts
        // every invite-less newcomer into the server that claims that host, and anyone may own a
        // server — one that claimed the instance's own address collected every new account.
        app.MapPut("/api/v1/servers/{id:long}/domain", async (long id, SetDomainBody body, HttpContext ctx, ICurrentUser current,
            IServerRepository servers, ISpaceRegistry spaces, CancellationToken ct) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if ((current.Permissions & Perm.Administrator) == 0)
                throw DomainException.Forbidden("a custom domain is set by the space's administrator");
            var info = await servers.GetAsync(id) ?? throw DomainException.NotFound("server not found");
            if (info.OwnerId != current.UserId) throw DomainException.Forbidden("only the owner can set the domain");
            var domain = NormalizeDomain(body.Domain);
            if (string.IsNullOrEmpty(domain)) throw DomainException.BadRequest("enter a valid domain like chat.example.com");
            // Never an address that already means something here: this instance's own, or a space's.
            if (string.Equals(domain, ctx.Request.Host.Host, StringComparison.OrdinalIgnoreCase)
                || (await spaces.ListAsync(ct)).Any(s => string.Equals(s.Domain, domain, StringComparison.OrdinalIgnoreCase)))
                throw DomainException.Conflict("this domain is already in use");
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
