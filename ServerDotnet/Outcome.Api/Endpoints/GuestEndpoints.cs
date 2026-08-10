using Outcome.Api.Realtime;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Security;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Common;
using Outcome.Domain.Errors;
using Perms = Outcome.Shared.Abstractions.Authorization.Permissions;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Endpoints;

/// <summary>
/// No-login guest access to voice channels. A member with ManageInvites mints a shareable
/// link; a visitor opens it, types a display name, and gets a short-lived AUDIO-ONLY
/// LiveKit token — never an Outcome session. The join endpoint is the abuse surface, so it
/// is rate-limited per IP and instance-wide.
/// </summary>
public static class GuestEndpoints
{
    public sealed record GuestJoinBody(string? DisplayName);

    public static void MapGuestEndpoints(this IEndpointRouteBuilder app)
    {
        // ── Member side: the server-management view ──────────────────────────────
        // Every voice channel of the ACTIVE server with its link (null when it has none), so
        // the "Guest access" window can show codes without minting one per channel on open.
        app.MapGet("/api/v1/servers/guest-links", async (HttpContext ctx,
            ICurrentUser current, ICurrentServer srv, IGuestLinkRepository links) =>
        {
            RequireInviter(current);
            var list = await links.ListForServerAsync(srv.ServerId);
            var origin = PublicOrigin(ctx);
            return list.Select(l => new
            {
                channel_id = l.ChannelId,
                channel_name = l.ChannelName,
                code = l.Code,
                url = l.Code is null ? null : $"{origin}/guest/{l.Code}",
            });
        });

        // ── Member side: mint / revoke the channel's link ─────────────────────────
        app.MapPost("/api/v1/channels/{id:long}/guest-link", async (long id, HttpContext ctx,
            ICurrentUser current, ICurrentServer srv, IChannelRepository channels, IGuestLinkRepository links,
            IConnectionRegistry registry, ICurrentSpace space) =>
        {
            RequireInviter(current);
            var channel = await ValidateVoiceChannelAsync(id, srv, channels);
            var link = await links.GetOrCreateAsync(channel.Id, current.UserId);
            return Results.Json(new { code = link.Code, url = $"{PublicOrigin(ctx)}/guest/{link.Code}" });
        });

        app.MapDelete("/api/v1/channels/{id:long}/guest-link", async (long id,
            ICurrentUser current, ICurrentServer srv, IChannelRepository channels,
            IGuestLinkRepository links, ILiveKitRoomService livekit,
            GuestPresence guests, IConnectionRegistry registry, ICurrentSpace space) =>
        {
            RequireInviter(current);
            var channel = await ValidateVoiceChannelAsync(id, srv, channels);
            if (!await links.RevokeAsync(channel.Id)) throw DomainException.NotFound("no active guest link");
            // Revoking must EVICT: the code dying isn't enough if guests are already talking.
            await livekit.RemoveGuestsAsync(channel.Id);
            // And the roster must drop them NOW, directly — the eviction's participant_left
            // webhooks normally handle this, but revoke shouldn't depend on that path working.
            foreach (var gid in guests.Clear(space.Space.Id, channel.Id))
                await registry.BroadcastAsync(WsFrames.VoiceLeave(channel.Id, gid));
            return Results.NoContent();
        });

        // ── Guest side (NO auth) ─────────────────────────────────────────────────
        app.MapGet("/api/v1/guest/{code}", async (string code, HttpContext ctx,
            IGuestLinkRepository links, IChannelRepository channels, IServerRepository servers, IRateLimiter limiter) =>
        {
            if (!limiter.Allow($"guest_info:{ClientIp(ctx)}", 30, TimeSpan.FromMinutes(1)))
                throw new DomainException("RATE_LIMITED", 429, "too many requests");

            var (link, channel) = await ResolveAsync(code, links, channels);
            var server = channel.ServerId is { } sid ? await servers.GetAsync(sid) : null;
            return Results.Json(new { channel_name = channel.Name, server_name = server?.Name ?? "Outcome" });
        });

        app.MapPost("/api/v1/guest/{code}/join", async (string code, GuestJoinBody? body, HttpContext ctx,
            IGuestLinkRepository links, IChannelRepository channels, ILiveKitTokenService livekit, IRateLimiter limiter) =>
        {
            // Strict: minting media tokens for anonymous visitors is the whole attack surface.
            if (!limiter.Allow($"guest_join:{ClientIp(ctx)}", 5, TimeSpan.FromMinutes(1))
                || !limiter.Allow("global:guest_join", 120, TimeSpan.FromMinutes(1)))
                throw new DomainException("RATE_LIMITED", 429, "too many join attempts, please wait a moment");

            var (link, channel) = await ResolveAsync(code, links, channels);
            if (!livekit.IsConfigured) throw DomainException.Server("voice is not configured on this instance");

            var name = TextSanitizer.StripHtml(body?.DisplayName ?? "").Trim();
            if (name.Length < 2) throw DomainException.InvalidInput("display name must be at least 2 characters");
            if (name.Length > 24) name = name[..24];

            // "(гость)" is appended server-side so a visitor can't impersonate a member.
            var token = livekit.GenerateGuestToken($"{name} (guest)", channel.Id);
            return Results.Json(new { token, url = "/livekit", channel_name = channel.Name });
        });
    }

    /// <summary>Active link → its channel; both errors collapse into one message so probing
    /// codes reveals nothing about which ones exist.</summary>
    private static async Task<(Domain.Entities.GuestLink, Domain.Entities.Channel)> ResolveAsync(
        string code, IGuestLinkRepository links, IChannelRepository channels)
    {
        var link = (code.Length is > 0 and <= 64 ? await links.GetByCodeAsync(code) : null)
                   ?? throw DomainException.NotFound("this guest link is invalid or has been revoked");
        var channel = await channels.GetByIdAsync(link.ChannelId);
        if (channel is null || channel.Type != "voice")
            throw DomainException.NotFound("this guest link is invalid or has been revoked");
        return (link, channel);
    }

    private static async Task<Domain.Entities.Channel> ValidateVoiceChannelAsync(
        long id, ICurrentServer srv, IChannelRepository channels)
    {
        var channel = await channels.GetByIdAsync(id) ?? throw DomainException.NotFound("channel not found");
        if (channel.Type != "voice") throw DomainException.BadRequest("guest links are for voice channels");
        if (channel.ServerId is { } sid && sid != srv.ServerId)
            throw DomainException.Forbidden("channel is not in your active server");
        return channel;
    }

    private static void RequireInviter(ICurrentUser current)
    {
        if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
        if (!Perms.Grants(Perms.FromBits(current.Permissions), Perms.ManageInvites))
            throw DomainException.Forbidden("insufficient permissions");
    }

    /// <summary>The origin guests will open — honor the reverse proxy's scheme/host.</summary>
    private static string PublicOrigin(HttpContext ctx)
    {
        var proto = ctx.Request.Headers["X-Forwarded-Proto"].ToString();
        if (string.IsNullOrEmpty(proto)) proto = ctx.Request.Scheme;
        var host = ctx.Request.Headers["X-Forwarded-Host"].ToString();
        if (string.IsNullOrEmpty(host)) host = ctx.Request.Host.ToString();
        return $"{proto}://{host}";
    }

    private static string ClientIp(HttpContext ctx) =>
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}
