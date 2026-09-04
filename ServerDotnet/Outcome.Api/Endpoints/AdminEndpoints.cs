using MediatR;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using Outcome.Api.Realtime;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Security;
using Outcome.Infrastructure.Mail;
using Outcome.Application.Admin;
using Outcome.Application.Channels;
using Outcome.Application.Roles;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Endpoints;

public static class AdminEndpoints
{
    public sealed record BanBody(string? Reason);
    public sealed record CreateChannelBody(string Name, string Type, string? Category, string? Topic, int? Position);
    public sealed record UpdateChannelBody(string? Name, string? Topic, int? SlowMode, int? Position, bool? Archived);
    public sealed record AdminUserPatchBody(long? RoleId, bool? Banned, string? BanReason);
    public sealed record GrantPermBody(string Permission);

    /// <summary>Instance-admin gate: only the global Administrator bit passes (used for the
    /// destructive cross-server / hard-delete / permission actions).</summary>

    private static void RequireAdmin(ICurrentUser current)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        if ((current.Permissions & Outcome.Domain.Permissions.Permission.Administrator) == 0)
            throw DomainException.Forbidden("administrator only");
    }

    /// <summary>
    /// Gate for operations that belong to whoever RUNS the instance rather than to a customer:
    /// process-wide logs (every tenant's lines are in that ring), infrastructure health, the
    /// instance settings, the bug queue. A space owner is a full administrator INSIDE their
    /// space — the Administrator bit alone must not open these, or the tenancy boundary is
    /// only a matter of which buttons the UI happens to render.
    /// </summary>
    /// <summary>Body of a reply from the support mailbox.</summary>
    public sealed record ReplyBody(string? Text);

    private static void RequireInstanceAdmin(ICurrentUser current, ICurrentSpace space)
    {
        RequireAdmin(current);
        if (!space.Space.IsRoot) throw DomainException.Forbidden("this belongs to the main instance");
    }

    public static void MapAdminEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/admin");

        // ── Settings ─────────────────────────────────────────────────────────────
        group.MapGet("/settings", async (ICurrentUser current, ICurrentSpace space, ISender mediator) =>
        {
            RequireInstanceAdmin(current, space);
            return await mediator.Send(new GetSettingsQuery(current.Permissions));
        });

        group.MapPatch("/settings", async (Dictionary<string, string> body, ICurrentUser current, ICurrentSpace space, ISender mediator) =>
        {
            RequireInstanceAdmin(current, space);
            return await mediator.Send(new PatchSettingsCommand(body, current.Permissions));
        });

        // ── Users ────────────────────────────────────────────────────────────────
        // Paged when limit/offset are passed; the body stays a plain array either way and the
        // unpaged total rides the X-Total-Count header (keeps the mobile admin, which never
        // pages, on the exact same contract).
        // Every account in the SPACE, so the gate is the space's, not a server's. The handler asks
        // for ManageServer, which is a permission a per-server role can carry — belt and braces
        // after that bit turned out to be reachable by anyone who created a server of their own.
        group.MapGet("/users", async (int? limit, int? offset, string? q, HttpContext ctx, ICurrentUser current, ISender mediator) =>
        {
            RequireAdmin(current);
            var page = await mediator.Send(new ListAdminUsersQuery(current.Permissions, limit ?? int.MaxValue, offset ?? 0, q));
            ctx.Response.Headers["X-Total-Count"] = page.Total.ToString();
            return page.Items;
        });

        group.MapPost("/users/{id:long}/ban", async (long id, BanBody? body, ICurrentUser current, ICurrentServer srv, IConnectionRegistry registry, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new BanUserCommand(id, body?.Reason ?? string.Empty, current.UserId, current.Permissions));
            await registry.CloseUserAsync(id);
            await registry.BroadcastToServerAsync(srv.ServerId, WsFrames.MemberBan(id));
            return Results.NoContent();
        });

        group.MapPost("/users/{id:long}/unban", async (long id, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new UnbanUserCommand(id, current.UserId, current.Permissions));
            return Results.NoContent();
        });

        // Unified PATCH the web client uses for adminBanMember / adminChangeRole.
        group.MapPatch("/users/{id:long}", async (long id, AdminUserPatchBody body, ICurrentUser current, ICurrentServer srv, IConnectionRegistry registry, IRoleRepository roles, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");

            if (body.RoleId is { } roleId)
            {
                await mediator.Send(new AssignRoleCommand(id, roleId, current.Permissions));
                var role = await roles.GetByIdAsync(roleId);
                await registry.BroadcastToServerAsync(srv.ServerId, WsFrames.MemberUpdate(id, (role?.Name ?? "member").ToLowerInvariant()));
            }

            if (body.Banned is true)
            {
                await mediator.Send(new BanUserCommand(id, body.BanReason ?? string.Empty, current.UserId, current.Permissions));
                await registry.CloseUserAsync(id);
                await registry.BroadcastToServerAsync(srv.ServerId, WsFrames.MemberBan(id));
            }
            else if (body.Banned is false)
            {
                await mediator.Send(new UnbanUserCommand(id, current.UserId, current.Permissions));
            }

            return Results.NoContent();
        });

        // Kick = revoke all sessions + force-close the socket + broadcast member_leave.
        group.MapDelete("/users/{id:long}/sessions", async (long id, ICurrentUser current, ICurrentServer srv, IConnectionRegistry registry, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new KickUserCommand(id, current.UserId, current.Permissions));
            await registry.CloseUserAsync(id);
            await registry.BroadcastToServerAsync(srv.ServerId, WsFrames.MemberLeave(id));
            return Results.NoContent();
        });

        // HARD-delete a user (instance admin): permanently removes the account + its messages,
        // invites, uploads. NOT a soft delete — the row is gone. Owner/global-admin only.
        group.MapDelete("/users/{id:long}", async (long id, ICurrentUser current, IConnectionRegistry registry, IUserRepository users) =>
        {
            RequireAdmin(current);
            if (id == current.UserId) throw DomainException.BadRequest("you can't delete your own account here");
            await users.DeleteAsync(id);
            await registry.CloseUserAsync(id);
            await registry.BroadcastAsync(WsFrames.MemberDelete(id));
            return Results.NoContent();
        });

        // ── Direct user permission grants (user_claims) ──────────────────────────
        group.MapGet("/permissions", (ICurrentUser current) =>
        {
            RequireAdmin(current);
            return Results.Ok(Perms.All);
        });

        group.MapGet("/users/{id:long}/permissions", async (long id, ICurrentUser current, IPermissionRepository perms) =>
        {
            RequireAdmin(current);
            return Results.Ok(await perms.GetForUserAsync(id));
        });

        group.MapPost("/users/{id:long}/permissions", async (long id, GrantPermBody body, ICurrentUser current, IPermissionRepository perms) =>
        {
            RequireAdmin(current);
            if (string.IsNullOrWhiteSpace(body.Permission) || !Perms.All.Contains(body.Permission))
                throw DomainException.BadRequest("unknown permission");
            await perms.AddToUserAsync(id, body.Permission);
            return Results.NoContent();
        });

        group.MapDelete("/users/{id:long}/permissions/{permission}", async (long id, string permission, ICurrentUser current, IPermissionRepository perms) =>
        {
            RequireAdmin(current);
            await perms.RemoveFromUserAsync(id, permission);
            return Results.NoContent();
        });

        // ── Cross-server management (instance admin): any server, any channel ─────
        group.MapGet("/servers", async (int? limit, int? offset, HttpContext ctx, ICurrentUser current,
            IServerRepository servers, IUserRepository users) =>
        {
            RequireAdmin(current);
            var page = await servers.ListAllAsync(limit ?? int.MaxValue, offset ?? 0);
            ctx.Response.Headers["X-Total-Count"] = (await servers.CountAllAsync()).ToString();
            var counts = await servers.MemberCountsAsync(page.Select(x => x.Id).ToList());
            // Who to write to when a complaint lands. An owner id alone means looking the person
            // up by hand every single time, which is the moment a moderation queue stops moving.
            var owners = (await users.ListByIdsAsync(page.Select(x => x.OwnerId).Distinct().ToList()))
                .ToDictionary(u => u.Id);
            return Results.Ok(page.Select(s => new
            {
                id = s.Id, name = s.Name, owner_id = s.OwnerId, icon = s.Icon,
                owner_username = owners.TryGetValue(s.OwnerId, out var o) ? o.UserName : null,
                owner_email = owners.TryGetValue(s.OwnerId, out var o2) ? o2.Email : null,
                custom_domain = s.CustomDomain,
                member_count = counts.TryGetValue(s.Id, out var c) ? c : 0,
            }));
        });

        group.MapDelete("/servers/{id:long}", async (long id, ICurrentUser current, IServerRepository servers) =>
        {
            RequireAdmin(current);
            if (!await servers.AdminDeleteAsync(id)) throw DomainException.NotFound("server not found");
            return Results.NoContent();
        });

        group.MapGet("/servers/{id:long}/channels", async (long id, ICurrentUser current, IChannelRepository channels) =>
        {
            RequireAdmin(current);
            var list = await channels.ListAsync(id);
            return Results.Ok(list.Select(c => new { id = c.Id, name = c.Name, type = c.Type, category = c.Category, server_id = c.ServerId }));
        });

        // Force-delete ANY channel by id (any server). Broadcasts to that channel's owning server.
        group.MapDelete("/channels/{id:long}/force", async (long id, ICurrentUser current, IConnectionRegistry registry, IChannelRepository channels) =>
        {
            RequireAdmin(current);
            var ch = await channels.GetByIdAsync(id) ?? throw DomainException.NotFound("channel not found");
            if (!await channels.DeleteAsync(id)) throw DomainException.NotFound("channel not found");
            if (ch.ServerId is { } sid) await registry.BroadcastToServerAsync(sid, WsFrames.ChannelDelete(id));
            return Results.NoContent();
        });

        // ── Channels (ManageChannels) ────────────────────────────────────────────
        group.MapPost("/channels", async (CreateChannelBody body, ICurrentUser current, ICurrentServer srv, IConnectionRegistry registry, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var dto = await mediator.Send(new CreateChannelCommand(
                body.Name, body.Type, body.Category ?? string.Empty, body.Topic ?? string.Empty, body.Position ?? 0, current.Permissions));
            await registry.BroadcastToServerAsync(srv.ServerId, WsFrames.ChannelCreate(
                dto.Id, dto.Name, dto.Type, string.IsNullOrEmpty(dto.Category) ? null : dto.Category, dto.Position));
            return dto;
        });

        group.MapPatch("/channels/{id:long}", async (long id, UpdateChannelBody body, ICurrentUser current, ICurrentServer srv, IConnectionRegistry registry, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var dto = await mediator.Send(new UpdateChannelCommand(
                id, body.Name, body.Topic, body.SlowMode, body.Position, body.Archived, current.Permissions));
            await registry.BroadcastToServerAsync(srv.ServerId, WsFrames.ChannelUpdate(dto.Id, dto.Name, dto.Position));
            return dto;
        });

        group.MapDelete("/channels/{id:long}", async (long id, ICurrentUser current, ICurrentServer srv, IConnectionRegistry registry, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            await mediator.Send(new DeleteChannelCommand(id, current.Permissions));
            await registry.BroadcastToServerAsync(srv.ServerId, WsFrames.ChannelDelete(id));
            return Results.NoContent();
        });

        // ── Support mailbox ──────────────────────────────────────────────────────
        // The shared inbox, read and answered from here. Instance-only: it is one mailbox
        // belonging to whoever runs the instance, not a per-tenant feature — a space owner
        // reaching it would be reading somebody else's support queue.
        group.MapGet("/mail", async (int? limit, int? offset, ICurrentUser current, ICurrentSpace space,
            SupportMailbox mail, HttpContext ctx, CancellationToken ct) =>
        {
            RequireInstanceAdmin(current, space);
            if (!mail.Configured) return Results.Ok(new { configured = false, messages = Array.Empty<object>() });
            var items = await mail.ListAsync(limit ?? 50, offset ?? 0, ct);
            return Results.Ok(new { configured = true, messages = items });
        });

        group.MapGet("/mail/{uid:int}", async (uint uid, ICurrentUser current, ICurrentSpace space,
            SupportMailbox mail, CancellationToken ct) =>
        {
            RequireInstanceAdmin(current, space);
            return await mail.GetAsync(uid, ct);
        });

        group.MapPost("/mail/{uid:int}/reply", async (uint uid, ReplyBody body, ICurrentUser current,
            ICurrentSpace space, SupportMailbox mail, CancellationToken ct) =>
        {
            RequireInstanceAdmin(current, space);
            await mail.ReplyAsync(uid, body.Text ?? "", ct);
            return Results.NoContent();
        });

        // ── Diagnostics / Audit / Logs ───────────────────────────────────────────
        group.MapGet("/stats", async (ICurrentUser current, ICurrentSpace space, IConnectionRegistry registry, ISender mediator) =>
        {
            RequireInstanceAdmin(current, space);
            var s = await mediator.Send(new GetServerStatsQuery(current.Permissions));
            var proc = System.Diagnostics.Process.GetCurrentProcess();
            var uptime = (long)(DateTime.UtcNow - proc.StartTime.ToUniversalTime()).TotalSeconds;
            return new
            {
                UserCount = s.Users, MessageCount = s.Messages, ChannelCount = s.Channels,
                ServerCount = s.Servers, InviteCount = s.Invites, OnlineCount = registry.Count,
                DbSizeBytes = s.DbSizeBytes, UptimeSeconds = uptime, Version = "0.1.0-dotnet",
            };
        });

        // System health: liveness of each backing service + which replica/node answered.
        // This is the "what's up / what's down" view for the owner dashboard.
        group.MapGet("/health/services", async (
            ICurrentUser current, ICurrentSpace space, IConnectionRegistry registry,
            IServiceProvider sp, IConfiguration cfg, ISettingsRepository settings) =>
        {
            // Infrastructure shared by every tenant: Postgres, Redis, MinIO, LiveKit.
            RequireInstanceAdmin(current, space);

            async Task<object> Check(string name, Func<Task> probe)
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                try { await probe(); return new { name, ok = true, ms = sw.ElapsedMilliseconds, error = (string?)null }; }
                catch (Exception ex) { return new { name, ok = false, ms = sw.ElapsedMilliseconds, error = ex.Message }; }
            }

            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };

            var checks = new List<object>();

            // Postgres — any query round-trips the DB.
            checks.Add(await Check("PostgreSQL", async () => { await settings.GetAsync("server_name", CancellationToken.None); }));

            // Redis — only when the backplane is configured (multi-replica mode).
            var redis = sp.GetService<StackExchange.Redis.IConnectionMultiplexer>();
            checks.Add(redis is null
                ? new { name = "Redis", ok = true, ms = 0L, error = (string?)"not configured (single-node)" }
                : await Check("Redis", async () => { await redis.GetDatabase().PingAsync(); }));

            // LiveKit — HTTP liveness on the internal signaling URL.
            var lkUrl = (cfg["Voice:LiveKitInternalUrl"] ?? "ws://livekit:7880")
                .Replace("wss://", "https://").Replace("ws://", "http://");
            checks.Add(await Check("LiveKit", async () => { (await http.GetAsync(lkUrl)).EnsureSuccessStatusCode(); }));

            // MinIO — object storage health endpoint.
            var minioEp = cfg["Minio:Endpoint"] ?? "minio:9000";
            var minioScheme = (cfg["Minio:UseSsl"] ?? "false").Equals("true", StringComparison.OrdinalIgnoreCase) ? "https" : "http";
            checks.Add(await Check("MinIO", async () => { (await http.GetAsync($"{minioScheme}://{minioEp}/minio/health/live")).EnsureSuccessStatusCode(); }));

            var proc = System.Diagnostics.Process.GetCurrentProcess();
            return new
            {
                node = new
                {
                    hostname = Environment.MachineName, // container id = replica identity
                    online_here = registry.Count,        // sockets attached to THIS replica
                    uptime_seconds = (long)(DateTime.UtcNow - proc.StartTime.ToUniversalTime()).TotalSeconds,
                    redis_backplane = redis is not null,
                },
                services = checks,
            };
        });

        group.MapGet("/audit-log", async (int? limit, int? offset, HttpContext ctx, ICurrentUser current, ISender mediator) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            var page = await mediator.Send(new GetAuditLogQuery(current.Permissions, limit ?? 50, offset ?? 0));
            ctx.Response.Headers["X-Total-Count"] = page.Total.ToString();
            return page.Items;
        });

        // Exchange the (header-authenticated) session for a single-use ticket the SSE EventSource
        // can pass as a query param — see GET /api/v1/admin/logs/stream in Program.cs.
        group.MapPost("/logs/ticket", (ICurrentUser current, ICurrentSpace space, Outcome.Api.Logging.LogTicketStore tickets) =>
        {
            // The ring holds EVERY tenant's log lines — this is the operator's window, not a
            // customer's.
            RequireInstanceAdmin(current, space);
            return new { Ticket = tickets.Issue() };
        });
    }
}
