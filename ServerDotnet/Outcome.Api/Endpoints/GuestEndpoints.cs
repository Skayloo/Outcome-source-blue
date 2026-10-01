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
    public sealed record GuestShareBody(bool AllowGuestShare);
    public sealed record GuestChatBody(string? Content);

    /// <summary>The longest line a guest may post in a room chat. Members get the channel's
    /// 4000; a visitor with a link gets a quarter of it.</summary>
    private const int GuestChatMaxLength = 1000;

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
                allow_guest_share = l.AllowGuestShare,
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
            return Results.Json(new { code = link.Code, url = $"{PublicOrigin(ctx)}/guest/{link.Code}", allow_guest_share = link.AllowGuestShare });
        });

        // Whether guests of the channel's link may pass it on ("copy the invite" in the guest UI).
        app.MapPatch("/api/v1/channels/{id:long}/guest-link", async (long id, GuestShareBody body,
            ICurrentUser current, ICurrentServer srv, IChannelRepository channels, IGuestLinkRepository links) =>
        {
            RequireInviter(current);
            var channel = await ValidateVoiceChannelAsync(id, srv, channels);
            if (!await links.SetGuestShareAsync(channel.Id, body.AllowGuestShare))
                throw DomainException.NotFound("no active guest link");
            return Results.Json(new { allow_guest_share = body.AllowGuestShare });
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
            // The global ceiling is not decoration: behind a NAT that hides every client the
            // per-client bucket above is shared, so this is what actually bounds the endpoint.
            if (!ClientRate.Allow(limiter, ctx, "guest_info", 30, TimeSpan.FromMinutes(1))
                || !limiter.Allow("global:guest_info", 1200, TimeSpan.FromMinutes(1)))
                throw new DomainException("RATE_LIMITED", 429, "too many requests");

            var (link, channel) = await ResolveAsync(code, links, channels);
            var server = channel.ServerId is { } sid ? await servers.GetAsync(sid) : null;
            return Results.Json(new
            {
                channel_name = channel.Name,
                server_name = server?.Name ?? "Outcome",
                can_share = link.AllowGuestShare,
            });
        });

        // ── Signed-in side: the same link, opened by someone with an account here ─────
        // One link for everybody. A member of the room's server goes in as themselves — this only
        // tells their client where the room is; voice_join still checks membership on its own, so
        // the link opens nothing a member couldn't already reach. Anyone else stays a guest: the
        // link is a seat in one room, not a way into the server (owner's call, W3GWG-25), and the
        // ids are withheld from them for the same reason.
        app.MapGet("/api/v1/guest/{code}/account", async (string code, HttpContext ctx,
            ICurrentUser current, IGuestLinkRepository links, IChannelRepository channels,
            IServerRepository servers, IUserRepository users, IRateLimiter limiter) =>
        {
            if (!current.IsAuthenticated) throw DomainException.Unauthorized("not authenticated");
            if (!ClientRate.Allow(limiter, ctx, "guest_account", 30, TimeSpan.FromMinutes(1)))
                throw new DomainException("RATE_LIMITED", 429, "too many requests");

            var (_, channel) = await ResolveAsync(code, links, channels);
            var member = channel.ServerId is { } sid && await servers.IsMemberAsync(sid, current.UserId);
            // The name to show, or to fill in as the guest name. From here rather than from the
            // client: the web's stored session holds whatever was typed into the login form,
            // which is as often the e-mail address as the username.
            var username = (await users.GetByIdAsync(current.UserId))?.Username ?? "";
            return member
                ? Results.Json(new { member = true, username, server_id = channel.ServerId, channel_id = channel.Id, channel_name = channel.Name })
                : Results.Json(new { member = false, username, channel_name = channel.Name });
        });

        app.MapPost("/api/v1/guest/{code}/join", async (string code, GuestJoinBody? body, HttpContext ctx,
            IGuestLinkRepository links, IChannelRepository channels, ILiveKitTokenService livekit, IRateLimiter limiter) =>
        {
            // Strict: minting media tokens for anonymous visitors is the whole attack surface.
            if (!ClientRate.Allow(limiter, ctx, "guest_join", 5, TimeSpan.FromMinutes(1))
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

        // ── Guest side: the room's chat (W3GWG-25 stage 3) ────────────────────────
        // Guests have no account and no socket, so they read by polling and write over REST, with
        // the token they joined the call with as their only credential. They see what was said
        // from the moment they joined, as the owner decided — not the room's whole history.
        app.MapGet("/api/v1/guest/{code}/chat", async (string code, long? after, HttpContext ctx,
            IGuestLinkRepository links, IChannelRepository channels, IMessageRepository messages,
            ILiveKitTokenService livekit, ICurrentSpace space, IRateLimiter limiter) =>
        {
            var (_, channel) = await ResolveAsync(code, links, channels);
            var guest = GuestOf(ctx, livekit, space, channel.Id);
            // A poll every couple of seconds is the expected load; this is several times that.
            if (!limiter.Allow($"guest_chat_read:{space.Space.Id}:{guest.Identity}", 90, TimeSpan.FromMinutes(1)))
                throw new DomainException("RATE_LIMITED", 429, "too many requests");
            // From the moment the token was minted — the join — and not a second earlier: what was
            // said before the guest arrived is the room's, not theirs (the owner's rule).
            // The room's chat is its attached text channel (falls back to the room itself for a voice
            // channel made before chats were attached and somehow missed by the migration).
            var rows = await messages.ListForGuestAsync(channel.ChatChannelId ?? channel.Id, after ?? 0, guest.IssuedAt, 100);
            return Results.Json(rows.Select(r => new
            {
                id = r.Id, author = r.Author, guest = r.Guest, avatar = r.Avatar, content = r.Content, timestamp = r.Timestamp,
            }));
        });

        app.MapPost("/api/v1/guest/{code}/chat", async (string code, GuestChatBody? body, HttpContext ctx,
            IGuestLinkRepository links, IChannelRepository channels, IMessageRepository messages, IUserRepository users,
            ILiveKitTokenService livekit, ICurrentSpace space, IRateLimiter limiter,
            IMessageReplayBuffer replay, IConnectionHub hub) =>
        {
            var (_, channel) = await ResolveAsync(code, links, channels);
            var guest = GuestOf(ctx, livekit, space, channel.Id);
            if (!limiter.Allow($"guest_chat:{space.Space.Id}:{guest.Identity}", 5, TimeSpan.FromSeconds(10))
                || !limiter.Allow($"global:guest_chat:{space.Space.Id}", 300, TimeSpan.FromMinutes(1)))
                throw new DomainException("RATE_LIMITED", 429, "too many messages, slow down");

            var content = TextSanitizer.StripHtml(body?.Content);
            if (content.Length == 0) throw DomainException.BadRequest("message content cannot be empty");
            if (content.Length > GuestChatMaxLength)
                throw DomainException.BadRequest($"message content exceeds maximum length of {GuestChatMaxLength} characters");
            if (ContentFilter.FirstProhibited(content) is { } hit)
                throw DomainException.ContentBlocked($"this message was blocked by the content filter ({hit})");

            var name = GuestNameOf(guest);
            var authorId = await users.GuestAuthorIdAsync();
            var chatId = channel.ChatChannelId ?? channel.Id;
            var (id, timestamp) = await messages.CreateGuestAsync(chatId, authorId, name, content);

            // Into the members' feeds exactly as a member's message goes: same frame, same replay.
            // `user.username` carries the guest's name too, for a client that predates guest_name.
            var serverId = channel.ServerId ?? 0;
            var seq = replay.Next(space.Space.Id);
            var frame = WsFrames.ChatMessage(id, chatId, authorId, $"{name} (guest)", null, "guest", content,
                null, timestamp, seq, guestName: name);
            replay.Record(space.Space.Id, seq, serverId, frame);
            await hub.BroadcastToServerAsync(space.Space.Id, serverId, frame);
            return Results.Json(new { id, timestamp });
        });
    }

    /// <summary>
    /// The guest behind a request to the room chat: the LiveKit token they were given on join, sent
    /// in X-Guest-Token (not Authorization — that header belongs to the app's own sessions, and a
    /// token it cannot read must not look like an expired one), verified, and for THIS room.
    /// </summary>
    private static GuestTokenInfo GuestOf(HttpContext ctx, ILiveKitTokenService livekit, ICurrentSpace space, long channelId)
    {
        var jwt = ctx.Request.Headers["X-Guest-Token"].ToString().Trim();
        var info = livekit.ReadGuestToken(jwt);
        if (info is null || info.Room != LiveKitRooms.Name(space.Space.Id, channelId))
            throw DomainException.Forbidden("not a guest of this room");
        return info;
    }

    /// <summary>The name a guest typed, without the " (guest)" the server appended to it.</summary>
    private static string GuestNameOf(GuestTokenInfo g)
    {
        var name = g.Name.EndsWith(" (guest)", StringComparison.Ordinal) ? g.Name[..^" (guest)".Length] : g.Name;
        name = name.Trim();
        return name.Length > 40 ? name[..40] : name.Length == 0 ? "guest" : name;
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

}
