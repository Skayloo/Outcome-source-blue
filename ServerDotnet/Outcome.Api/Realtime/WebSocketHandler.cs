using System.Net.WebSockets;
using System.Threading.Channels;
using MediatR;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Authorization;
using Outcome.Shared.Abstractions.Notifications;
using Outcome.Shared.Abstractions.Persistence;
using Outcome.Shared.Abstractions.Realtime;
using Outcome.Shared.Abstractions.Security;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Application.Realtime;
using Outcome.Application.Voice;
using Outcome.Domain.Errors;
using Outcome.Infrastructure.Configuration;
using System.Text.Json;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Api.Realtime;

/// <summary>
/// Drives one raw-WebSocket connection: in-band auth → auth_ok + ready → read loop.
/// Outbound frames go through a single-writer channel pump so the socket is never written
/// from two places. Each inbound message is dispatched in its own DI scope (fresh UnitOfWork).
/// </summary>
public sealed class WebSocketHandler(
    IConnectionHub hub,
    IMessageReplayBuffer replay,
    IPendingCallStore pendingCalls,
    IServiceScopeFactory scopeFactory,
    IOptions<ServerOptions> serverOptions,
    IOptions<OAuthOptions> oauthOptions,
    GuestPresence guestPresence,
    PushNotifier pushNotifier,
    SessionRevocations revocations,
    IRateLimiter limiter,
    ILogger<WebSocketHandler> logger)
{
    // How long a call rings an offline callee before it's considered missed (kept in step with the
    // web client's RING_TIMEOUT_MS so a parked call can't pop after the caller already gave up).
    private static readonly TimeSpan RingWindow = TimeSpan.FromSeconds(45);
    private const int MaxFrameBytes = 1 << 20; // 1 MB
    private static readonly TimeSpan AuthDeadline = TimeSpan.FromSeconds(10);

    private sealed record AuthInfo(
        long UserId, string Username, string? Avatar, long RoleId, string Role, long Permissions, string ServerName, string Motd, long LastSeq, long ServerId,
        Space Space, string? DeviceId, string Origin = "", bool SpaceAdmin = false, string SessionHash = "");
    // RoleId is the SPACE role (users.role_id); Role is the role INSIDE the active server
    // ("owner" / "admin" / "moderator" / "member") — what every roster and message carries.

    /// <summary>The session half of a LiveKit identity: <c>user-{id}.{device}.{conn}</c> when the
    /// client names its device, <c>user-{id}.{conn}</c> when it does not. voice_join drops the
    /// account's sessions on OTHER devices only (see ILiveKitRoomService.RemoveOtherUserSessionsAsync),
    /// so the re-join a phone sends after every socket blip no longer throws out its own live session.
    /// The identity itself stays unique per connection on purpose: reusing one across a leave and a
    /// quick re-join let the old session's "disconnected" reach the others after the new session
    /// arrived, and the SDK — which tracks participants by identity — removed the new one: silence.</summary>
    private static string VoiceSessionFor(AuthInfo auth, Guid connId)
    {
        var conn = connId.ToString("N")[..8];
        return auth.DeviceId is { } device ? $"{device}.{conn}" : conn;
    }

    /// <summary>The connection that holds each user's voice session — the one that sent their last
    /// voice_join. Relayed key requests reach every device of the account, and one that is not in
    /// the call (a phone left open on the desk) may hold a stale key from an earlier call; once a
    /// user's voice connection is known, only the key IT sends is passed on. In memory, so empty
    /// after a restart until each user joins again.</summary>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<(long Space, long User), Guid> voiceConnections = new();

    /// <summary>Only what is safe inside a LiveKit identity; anything else is ignored, not rejected.</summary>
    private static string? ParseDeviceId(string? raw) =>
        raw is { Length: >= 8 and <= 32 } && raw.All(char.IsAsciiLetterOrDigit) ? raw : null;

    /// <param name="space">Resolved from the upgrade request's Host and pinned for the whole
    /// connection — a socket cannot wander between tenants mid-stream.</param>
    /// <param name="origin">https://host this socket came in on — see the WS route in Program.cs.</param>
    public async Task RunAsync(WebSocket ws, Space space, string origin, CancellationToken ct)
    {
        var auth = await AuthenticateAsync(ws, space, ct);
        if (auth is null) { await CloseQuietly(ws); return; }
        // The address push pictures are fetched from: the space's own, or the configured public one.
        // Never the Host the socket came in with — any client can send any Host (an unknown one
        // falls back to the root space), and the recipients' phones then fetched the picture, with
        // its signed URL, from wherever the SENDER pointed them. The socket's own only in dev.
        var configured = space.Domain is { Length: > 0 } d ? $"https://{d}" : oauthOptions.Value.PublicOrigin.TrimEnd('/');
        auth = auth with { Origin = configured.Length > 0 ? configured : origin };

        var connId = Guid.NewGuid();
        using var connCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var cct = connCts.Token;
        var outbound = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(256) { FullMode = BoundedChannelFullMode.DropOldest });
        ValueTask Send(byte[] msg) { outbound.Writer.TryWrite(msg); return ValueTask.CompletedTask; }

        var pump = Task.Run(async () =>
        {
            try
            {
                await foreach (var frame in outbound.Reader.ReadAllAsync(cct))
                    await ws.SendAsync(frame, WebSocketMessageType.Text, endOfMessage: true, cct);
            }
            catch { /* socket closed */ }
        }, cct);

        await Send(WsFrames.AuthOk(auth.UserId, auth.Username, auth.Avatar, auth.Role, auth.ServerName, auth.Motd, auth.SpaceAdmin));
        await Send(await BuildReadyAsync(auth, ct));

        // Register BEFORE replay so frames broadcast during the replay loop are delivered live
        // rather than lost; the client dedups by seq until replay_done.
        hub.Add(space.Id, auth.UserId, connId, auth.ServerId, Send, () => { try { connCts.Cancel(); } catch { /* already disposed */ } });

        // Reconnect replay: deliver broadcast messages this client missed while disconnected.
        // Tenant-scoped — the buffer records each frame's server so one user's reconnect can
        // never leak another server's traffic. replay_done tells the client dedup mode is over.
        if (auth.LastSeq > 0)
            foreach (var frame in replay.Since(space.Id, auth.LastSeq, auth.ServerId))
                await Send(frame);
        await Send(WsFrames.ReplayDone());

        // If someone rang this user while they were offline, deliver that call now (within its ring
        // window) so it pops the instant they open the app — instead of the caller getting a reject.
        if (pendingCalls.TryTake(space.Id, auth.UserId, out var parked))
            await Send(WsFrames.CallIncoming(parked.CallerId, parked.CallerName, parked.CallerAvatar, parked.ChannelId));

        await hub.BroadcastToServerAsync(space.Id, auth.ServerId, WsFrames.MemberJoin(auth.UserId, auth.Username, auth.Avatar, auth.Role));
        // Presence is instance-global state: a user is online everywhere they're a member,
        // so the frame goes to every connection (clients ignore users not in their roster).
        await hub.BroadcastAsync(space.Id, WsFrames.Presence(auth.UserId, "online"));
        await UpdateStatusAsync(space, auth.UserId, "online", ct);

        logger.LogInformation("websocket connected: user {UserId} ({Username})", auth.UserId, auth.Username);

        // The session was checked at auth only, so a socket outlived logout, a password change or
        // reset and "sign out everywhere" for good. Now it re-checks its own session at once when
        // one of the user's sessions is revoked here (SessionRevocations), and every minute anyway
        // — the backstop for an expired session, a ban made elsewhere, another replica's revoke.
        var watch = Task.Run(async () =>
        {
            try
            {
                var seen = revocations.Generation(space.Id, auth.UserId);
                var due = DateTime.UtcNow + SessionRecheck;
                while (!cct.IsCancellationRequested)
                {
                    await Task.Delay(RevocationPoll, cct);
                    var now = revocations.Generation(space.Id, auth.UserId);
                    if (now == seen && DateTime.UtcNow < due) continue;
                    seen = now;
                    due = DateTime.UtcNow + SessionRecheck;
                    if (!await SessionStillValidAsync(space, auth.UserId, auth.SessionHash, cct))
                    {
                        logger.LogInformation("websocket closed: session of user {UserId} no longer valid", auth.UserId);
                        try { connCts.Cancel(); } catch { /* already disposed */ }
                        return;
                    }
                }
            }
            catch { /* cancelled with the connection */ }
        }, cct);

        try
        {
            // One budget for everything a connection sends: a burst of FrameBurst, refilled at
            // FramesPerSecond. Only presence and calls had limits, and every other frame (a READY
            // rebuild, a broadcast, a LiveKit call) could be sent as fast as one socket can write,
            // from 64 sockets an address. Far above what any client does — a fast typist and a
            // key exchange together stay under a tenth of it.
            double tokens = FrameBurst;
            var refilledAt = Environment.TickCount64;
            var warnedAt = 0L;
            while (ws.State == WebSocketState.Open)
            {
                var raw = await ReadFrameAsync(ws, cct);
                if (raw is null) break;
                var now = Environment.TickCount64;
                tokens = Math.Min(FrameBurst, tokens + (now - refilledAt) / 1000.0 * FramesPerSecond);
                refilledAt = now;
                if (tokens < 1)
                {
                    if (now - warnedAt > 5000) { warnedAt = now; await Send(WsFrames.Error("RATE_LIMITED", "too many messages, slow down")); }
                    continue;
                }
                tokens -= 1;
                // DispatchAsync returns the (possibly re-scoped) auth so a switch_server
                // over the live socket updates the tenant for all subsequent frames + cleanup.
                auth = await DispatchAsync(auth, connId, raw, Send, cct);
            }
        }
        catch (Exception ex) { logger.LogDebug(ex, "ws read loop ended for user {UserId}", auth.UserId); }
        finally
        {
            hub.Remove(space.Id, auth.UserId, connId);
            outbound.Writer.TryComplete();
            try { await pump; } catch { /* ignore */ }
            if (!hub.IsOnline(space.Id, auth.UserId))
            {
                await UpdateStatusAsync(space, auth.UserId, "offline", CancellationToken.None);
                // Global: the user goes offline on EVERY server's roster, not just the last-viewed one.
                await hub.BroadcastAsync(space.Id, WsFrames.Presence(auth.UserId, "offline"));
                // Fire-and-forget: the voice cleanup sits behind a reconnect grace window,
                // and socket teardown must not wait it out.
                _ = LeaveVoiceOnDisconnectAsync(space, auth.UserId);
            }
            await CloseQuietly(ws);
            logger.LogInformation("websocket disconnected: user {UserId}", auth.UserId);
        }
    }

    private static readonly TimeSpan SessionRecheck = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan RevocationPoll = TimeSpan.FromSeconds(2);

    private async Task<bool> SessionStillValidAsync(Space space, long userId, string sessionHash, CancellationToken ct)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(space);
            var session = await scope.ServiceProvider.GetRequiredService<ISessionRepository>().GetByTokenHashAsync(sessionHash, ct);
            if (session is null || session.ExpiresAt <= DateTime.UtcNow || session.UserId != userId) return false;
            var user = await scope.ServiceProvider.GetRequiredService<IUserRepository>().GetByIdAsync(userId, ct);
            return user is { Deleted: false } && !(user.Banned && (user.BanExpires is null || user.BanExpires > DateTime.UtcNow));
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            // A database hiccup must not throw everyone out; the next round decides.
            logger.LogDebug(ex, "session re-check failed for user {UserId}", userId);
            return true;
        }
    }

    // ── Dispatch ─────────────────────────────────────────────────────────────
    private const double FrameBurst = 120;
    private const double FramesPerSecond = 20;

    private async Task<AuthInfo> DispatchAsync(AuthInfo auth, Guid connId, byte[] raw, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        string? type, reqId = null;
        JsonElement payload = default;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
            if (root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String) reqId = idEl.GetString();
            if (root.TryGetProperty("payload", out var p)) payload = p.Clone();
        }
        catch
        {
            await send(WsFrames.Error("BAD_REQUEST", "invalid message"));
            return auth;
        }

        switch (type)
        {
            case "ping":
                await send(WsFrames.Pong());
                break;

            case "attention":
                // Whether the person is at this connection now (app on screen or in a call; web in
                // front and touched lately). Decides pushes only: someone attending is told here.
                if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("active", out var att)
                    && att.ValueKind is JsonValueKind.True or JsonValueKind.False
                    && limiter.Allow($"ws-attention:{connId}", 60, TimeSpan.FromMinutes(1)))
                    hub.SetAttention(auth.Space.Id, auth.UserId, connId, att.ValueKind == JsonValueKind.True);
                break;

            case "switch_server":
                // Each one rebuilds a whole READY and tells the target server someone arrived.
                if (!limiter.Allow($"ws-switch:{connId}", 30, TimeSpan.FromMinutes(1)))
                {
                    await send(WsFrames.Error("RATE_LIMITED", "switching servers too fast"));
                    return auth;
                }
                return await HandleSwitchServerAsync(auth, connId, payload, send, ct);

            case "chat_send":
                await HandleChatSendAsync(auth, reqId, payload, send, ct);
                break;

            case "chat_edit":
                await HandleEditAsync(auth, payload, send, ct);
                break;

            case "chat_delete":
                await HandleDeleteAsync(auth, payload, send, ct);
                break;

            case "reaction_add":
                await HandleReactionAsync(auth, payload, send, add: true, ct);
                break;

            case "reaction_remove":
                await HandleReactionAsync(auth, payload, send, add: false, ct);
                break;

            case "voice_join":
                await HandleVoiceJoinAsync(auth, connId, payload, send, ct);
                break;
            case "voice_leave":
                await HandleVoiceLeaveAsync(auth, connId, ct);
                break;
            case "voice_mute":
                await HandleVoiceFlagAsync(auth, payload, VoiceFlag.Muted, "muted", send, ct);
                break;
            case "voice_deafen":
                await HandleVoiceFlagAsync(auth, payload, VoiceFlag.Deafened, "deafened", send, ct);
                break;
            case "voice_camera":
                await HandleVoiceFlagAsync(auth, payload, VoiceFlag.Camera, "enabled", send, ct);
                break;
            case "voice_screenshare":
                await HandleVoiceFlagAsync(auth, payload, VoiceFlag.Screenshare, "enabled", send, ct);
                break;
            case "voice_token_refresh":
                await HandleVoiceTokenRefreshAsync(auth, connId, send, ct);
                break;
            case "voice_record":
                await HandleVoiceRecordAsync(auth, payload, send, ct);
                break;

            case "read":
                if (TryGetLong(payload, "channel_id", out var readCh))
                    await HandleReadAsync(auth, readCh, ct);
                break;

            case "listen":
                if (payload.TryGetProperty("attachment_id", out var attEl)
                    && attEl.ValueKind == JsonValueKind.String && attEl.GetString() is { Length: > 0 } attId)
                    await HandleListenAsync(auth, attId, ct);
                break;

            case "typing_start":
                // Clients repeat it every few seconds while someone types; more often is noise fanned
                // out to a whole server.
                if (TryGetLong(payload, "channel_id", out var typingCh) && limiter.Allow($"ws-typing:{connId}:{typingCh}", 1, TimeSpan.FromSeconds(2)))
                    await HandleTypingAsync(auth, typingCh, ct);
                break;

            // ── direct call signaling (relay only; media rides LiveKit) ──────────
            case "call_offer":
                await HandleCallOfferAsync(auth, payload, send);
                break;
            case "call_accept":
                await HandleCallAcceptAsync(auth, payload);
                break;
            case "call_decline":
                await HandleCallDeclineAsync(auth, payload);
                break;
            case "call_cancel":
                await HandleCallCancelAsync(auth, payload);
                break;

            case "presence_update":
                {
                    var status = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("status", out var s)
                                 && s.ValueKind == JsonValueKind.String ? s.GetString() ?? "online" : "online";
                    // The statuses the clients offer, and not often: anything else was stored and
                    // sent to every socket in the space as it came — up to the 1 MB frame cap,
                    // escaped to ~6 MB, as fast as the sender could type.
                    if (status is not ("online" or "idle" or "dnd" or "offline")) break;
                    if (!limiter.Allow($"presence:{auth.Space.Id}:{auth.UserId}", 20, TimeSpan.FromMinutes(1))) break;
                    await UpdateStatusAsync(auth.Space, auth.UserId, status, ct);
                    // Global: status is per-user, visible on every server they're a member of.
                    await hub.BroadcastAsync(auth.Space.Id, WsFrames.Presence(auth.UserId, status));
                    break;
                }

            default:
                // Unhandled types (voice_*, reaction_*, channel_focus, …) are no-ops for now.
                break;
        }
        return auth;
    }

    // ── switch_server: re-scope the live connection to another tenant WITHOUT reconnecting ──
    // Keeps the socket (and thus voice presence + LiveKit audio) alive while the user browses a
    // different server. Only the active-server view + per-server permissions change.
    private async Task<AuthInfo> HandleSwitchServerAsync(AuthInfo auth, Guid connId, JsonElement payload, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        if (!TryGetLong(payload, "server_id", out var newServer) || newServer <= 0 || newServer == auth.ServerId)
            return auth;

        await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
        var serverRepo = scope.ServiceProvider.GetRequiredService<IServerRepository>();
        if (!await serverRepo.IsMemberAsync(newServer, auth.UserId, ct))
        {
            await send(WsFrames.Error("FORBIDDEN", "not a member of that server"));
            return auth;
        }

        var permissions = scope.ServiceProvider.GetRequiredService<IPermissionRepository>();

        // The role and permissions INSIDE the newly-active server (mirrors AuthenticateAsync; the
        // server role's grant is part of GetEffectiveForServerAsync).
        var serverRole = await serverRepo.GetServerRoleAsync(newServer, auth.UserId, ct);
        var permBits = Permissions.ToBits(await permissions.GetEffectiveForServerAsync(auth.UserId, newServer, ct));

        var newAuth = auth with
        {
            ServerId = newServer,
            Role = Outcome.Domain.Permissions.ServerRoles.Name(serverRole),
            Permissions = permBits,
        };

        // Re-tag the connection FIRST so the fresh READY + subsequent broadcasts route to the new tenant.
        hub.UpdateServer(auth.Space.Id, auth.UserId, connId, newServer);
        await send(await BuildReadyAsync(newAuth, ct));
        // Announce membership in the new server's roster. Presence is NOT re-broadcast: the user
        // is online instance-wide already, and they remain a member (and online) of the old server.
        await hub.BroadcastToServerAsync(auth.Space.Id, newServer, WsFrames.MemberJoin(newAuth.UserId, newAuth.Username, newAuth.Avatar, newAuth.Role));

        logger.LogInformation("user {UserId} switched active server → {ServerId} (voice preserved)", auth.UserId, newServer);
        return newAuth;
    }

    private async Task HandleChatSendAsync(AuthInfo auth, string? reqId, JsonElement payload, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        if (!TryGetLong(payload, "channel_id", out var channelId) || channelId <= 0)
        {
            await send(WsFrames.Error("BAD_REQUEST", "channel_id must be a positive integer"));
            return;
        }
        var content = payload.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
        long? replyTo = TryGetLong(payload, "reply_to", out var rt) ? rt : null;
        var forwardedFrom = payload.TryGetProperty("forwarded_from", out var ff) && ff.ValueKind == JsonValueKind.String
            ? ff.GetString()
            : null;

        var attachmentIds = new List<string>();
        if (payload.TryGetProperty("attachments", out var atts) && atts.ValueKind == JsonValueKind.Array)
            foreach (var el in atts.EnumerateArray())
                if (el.ValueKind == JsonValueKind.String && el.GetString() is { } s && s.Length > 0)
                    attachmentIds.Add(s);

        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            var created = await sender.Send(
                new CreateMessageCommand(channelId, content, replyTo, auth.UserId, auth.Permissions, auth.RoleId, auth.ServerId, attachmentIds, forwardedFrom), ct);

            await send(WsFrames.ChatSendOk(reqId, created.Id, created.Timestamp));
            var seq = replay.Next(auth.Space.Id);
            var frame = WsFrames.ChatMessage(
                created.Id, channelId, auth.UserId, auth.Username, auth.Avatar, auth.Role, created.Content, replyTo, created.Timestamp, seq, created.Attachments, created.ForwardedFrom);
            if (created.DmParticipantIds is { } participants)
            {
                // DM: deliver only to the participants, not a channel-wide broadcast (not replay-buffered).
                foreach (var pid in participants)
                    await hub.SendToUserAsync(auth.Space.Id, pid, frame);
            }
            else
            {
                // Broadcast into the CHANNEL's tenant — a cross-server forward must land in
                // the target server's live feeds, not the sender's active one.
                var targetServer = created.ServerId ?? auth.ServerId;
                replay.Record(auth.Space.Id, seq, targetServer, frame);
                await hub.BroadcastToServerAsync(auth.Space.Id, targetServer, frame);
            }

            // Whoever has no socket open hears about it from Apple instead.
            // The first picture, if there is one, rides along so the banner can show it, the way
            // Telegram does. The URL is already signed and already expiring — it is the same one
            // the app would fetch, handed over a little earlier — and made absolute, because the
            // notification extension that fetches it has no host to resolve a path against.
            var pushImage = created.Attachments
                .FirstOrDefault(a => a.Mime.StartsWith("image/", StringComparison.Ordinal))?.Url;
            if (pushImage is not null && pushImage.StartsWith('/') && auth.Origin.Length > 0) pushImage = auth.Origin + pushImage;
            pushNotifier.QueueMessage(auth.Space, channelId, auth.UserId, auth.Username, created.Content,
                pushImage,
                created.DmParticipantIds, created.DmParticipantIds is null ? created.ServerId ?? auth.ServerId : null,
                PushNotifier.AttachmentLabel(created.Attachments));
        }
        catch (DomainException ex)
        {
            await send(WsFrames.Error(ex.Code, ex.Message));
        }
    }

    private async Task HandleEditAsync(AuthInfo auth, JsonElement payload, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        if (!TryGetLong(payload, "message_id", out var mid) || mid <= 0)
        {
            await send(WsFrames.Error("BAD_REQUEST", "message_id must be a positive integer"));
            return;
        }
        var content = payload.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            var res = await sender.Send(new EditMessageCommand(mid, content, auth.UserId, auth.Permissions, auth.RoleId, auth.ServerId), ct);
            await SendToChannelAudienceAsync(scope.ServiceProvider, auth, res.ChannelId,
                WsFrames.ChatEdited(res.MessageId, res.ChannelId, res.Content, res.EditedAt), ct);
        }
        catch (DomainException ex)
        {
            await send(WsFrames.Error(ex.Code, ex.Message));
        }
    }

    /// <summary>A frame about a message goes to the people who can see that message: a DM's two
    /// participants, or the sockets of the channel's own server. Edits and reactions used to go to
    /// the SENDER's active server — a DM edit's new text reached everyone looking at that server.</summary>
    private async Task SendToChannelAudienceAsync(IServiceProvider sp, AuthInfo auth, long channelId, byte[] frame, CancellationToken ct)
    {
        var channel = await sp.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId, ct);
        if (channel is null) return;
        if (channel.Type == "dm" || channel.ServerId is null)
        {
            foreach (var pid in await sp.GetRequiredService<IDmRepository>().GetParticipantIdsAsync(channelId, ct))
                await hub.SendToUserAsync(auth.Space.Id, pid, frame);
            return;
        }
        await hub.BroadcastToServerAsync(auth.Space.Id, channel.ServerId.Value, frame);
    }

    /// <summary>"Is typing" goes where the channel is read: a DM's other participant, or the sockets of
    /// the channel's own server. It used to go to the typer's ACTIVE server — everyone looking at it
    /// learned who was writing to whom in private, and when.</summary>
    private async Task HandleTypingAsync(AuthInfo auth, long channelId, CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
        var sp = scope.ServiceProvider;
        var channel = await sp.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId, ct);
        if (channel is null) return;
        var frame = WsFrames.Typing(channelId, auth.UserId, auth.Username);
        if (channel.Type == "dm" || channel.ServerId is null)
        {
            var dms = sp.GetRequiredService<IDmRepository>();
            if (!await dms.IsParticipantAsync(auth.UserId, channelId, ct)) return;
            foreach (var pid in await dms.GetParticipantIdsAsync(channelId, ct))
                if (pid != auth.UserId) await hub.SendToUserAsync(auth.Space.Id, pid, frame);
            return;
        }
        var sid = channel.ServerId.Value;
        if (sid != auth.ServerId && !await sp.GetRequiredService<IServerRepository>().IsMemberAsync(sid, auth.UserId, ct)) return;
        await hub.BroadcastToServerAsync(auth.Space.Id, sid, frame);
    }

    private async Task HandleDeleteAsync(AuthInfo auth, JsonElement payload, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        if (!TryGetLong(payload, "message_id", out var mid) || mid <= 0)
        {
            await send(WsFrames.Error("BAD_REQUEST", "message_id must be a positive integer"));
            return;
        }
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            var res = await sender.Send(new DeleteMessageCommand(mid, auth.UserId, auth.Permissions, auth.RoleId, auth.ServerId), ct);
            var frame = WsFrames.ChatDeleted(res.MessageId, res.ChannelId, res.Purged);
            if (res.DmParticipantIds is { } participants)
            {
                // A DM has no server, so a server-wide broadcast would reach nobody — the peer
                // would go on showing a message that no longer exists.
                foreach (var pid in participants)
                    await hub.SendToUserAsync(auth.Space.Id, pid, frame);
            }
            else
            {
                await hub.BroadcastToServerAsync(auth.Space.Id, auth.ServerId, frame);
            }
        }
        catch (DomainException ex)
        {
            await send(WsFrames.Error(ex.Code, ex.Message));
        }
    }

    private async Task HandleReactionAsync(AuthInfo auth, JsonElement payload, Func<byte[], ValueTask> send, bool add, CancellationToken ct)
    {
        if (!TryGetLong(payload, "message_id", out var mid) || mid <= 0)
        {
            await send(WsFrames.Error("BAD_REQUEST", "message_id must be a positive integer"));
            return;
        }
        var emoji = payload.TryGetProperty("emoji", out var e) ? e.GetString() ?? "" : "";
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            var res = await sender.Send(new ReactCommand(mid, emoji, add, auth.UserId, auth.Permissions, auth.RoleId, auth.ServerId), ct);
            await SendToChannelAudienceAsync(scope.ServiceProvider, auth, res.ChannelId,
                WsFrames.ReactionUpdate(res.MessageId, res.ChannelId, res.Emoji, res.UserId, res.Action), ct);
        }
        catch (DomainException ex)
        {
            await send(WsFrames.Error(ex.Code, ex.Message));
        }
    }

    // ── Direct call signaling (relay only; no DB) ────────────────────────────
    private async Task HandleCallOfferAsync(AuthInfo auth, JsonElement payload, Func<byte[], ValueTask> send)
    {
        if (!TryGetLong(payload, "callee_id", out var callee) || callee <= 0 ||
            !TryGetLong(payload, "channel_id", out var channelId) || channelId <= 0)
        {
            await send(WsFrames.Error("BAD_REQUEST", "callee_id and channel_id must be positive integers"));
            return;
        }
        // Every offer to someone offline is a VoIP push, and iOS shows a CallKit call for each one:
        // without a limit anyone could ring a phone over and over. A real caller redials a few times.
        if (!limiter.Allow($"call:{auth.Space.Id}:{auth.UserId}", 10, TimeSpan.FromMinutes(1))
            || !limiter.Allow($"call:{auth.Space.Id}:{auth.UserId}:{callee}", 4, TimeSpan.FromMinutes(1)))
        {
            await send(WsFrames.Error("RATE_LIMITED", "too many calls, try again in a minute"));
            return;
        }
        // A block in either direction means the phone never rings (scoped resolve: this
        // handler is a singleton, repositories are per-request).
        using (var scope = scopeFactory.CreateScopeFor(auth.Space))
        {
            var blocks = scope.ServiceProvider.GetRequiredService<Outcome.Shared.Abstractions.Persistence.IBlockRepository>();
            if (await blocks.IsBlockedEitherWayAsync(auth.UserId, callee))
            {
                await send(WsFrames.Error("FORBIDDEN", "you cannot call this user"));
                return;
            }
            // A 1:1 call happens in the DM of exactly these two people — the callee's client joins
            // the room this names when it answers.
            if (!await IsDmBetweenAsync(scope.ServiceProvider, channelId, auth.UserId, callee))
            {
                await send(WsFrames.Error("FORBIDDEN", "a call takes place in your direct messages with that person"));
                return;
            }
        }
        if (ringing.Count > 1000)
            foreach (var (key, until) in ringing)
                if (until < DateTimeOffset.UtcNow) ringing.TryRemove(key, out _);
        ringing[(auth.Space.Id, auth.UserId, callee)] = DateTimeOffset.UtcNow.Add(RingWindow);
        if (hub.IsOnline(auth.Space.Id, callee))
        {
            await hub.SendToUserAsync(auth.Space.Id, callee, WsFrames.CallIncoming(auth.UserId, auth.Username, auth.Avatar, channelId));
        }
        else
        {
            // Ring them anyway: park the call so it pops the moment they come online (within the
            // ring window), AND wake a closed phone through APNs. The two are complements — the
            // parked call covers a client that reconnects on its own, the push covers a phone
            // that would otherwise never have known.
            pendingCalls.Park(auth.Space.Id, callee, new PendingCall(auth.UserId, auth.Username, auth.Avatar, channelId, DateTimeOffset.UtcNow.Add(RingWindow)));
            pushNotifier.QueueCall(auth.Space, callee,
                new CallPush(CallIdOf(auth.UserId, callee), auth.UserId, auth.Username, auth.Avatar, channelId));
        }
    }

    private async Task HandleCallAcceptAsync(AuthInfo auth, JsonElement payload)
    {
        if (!TryGetLong(payload, "caller_id", out var caller) || caller <= 0 ||
            !TryGetLong(payload, "channel_id", out var channelId) || channelId <= 0)
            return;
        // Only for the DM of these two people. The caller's client is the real gate (it acts only
        // on an answer to the call it placed); this keeps an accept from naming any other room.
        using (var scope = scopeFactory.CreateScopeFor(auth.Space))
            if (!await IsDmBetweenAsync(scope.ServiceProvider, channelId, auth.UserId, caller)) return;
        await hub.SendToUserAsync(auth.Space.Id, caller, WsFrames.CallAccepted(auth.UserId, channelId));
    }

    private static async Task<bool> IsDmBetweenAsync(IServiceProvider sp, long channelId, long a, long b)
    {
        if (a == b) return false;
        var channel = await sp.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId);
        if (channel is null || channel.Type != "dm") return false;
        var dms = sp.GetRequiredService<IDmRepository>();
        return await dms.IsParticipantAsync(a, channelId) && await dms.IsParticipantAsync(b, channelId);
    }

    private async Task HandleCallDeclineAsync(AuthInfo auth, JsonElement payload)
    {
        if (!TryGetLong(payload, "caller_id", out var caller) || caller <= 0 || caller == auth.UserId) return;
        // Only between people who share a DM — calls are placed in one — and at a call's pace: it
        // went to any user id, and the phone dropped whatever call it was placing on any decline.
        if (!limiter.Allow($"call_decline:{auth.Space.Id}:{auth.UserId}", 20, TimeSpan.FromMinutes(1))) return;
        using (var scope = scopeFactory.CreateScopeFor(auth.Space))
            if (await scope.ServiceProvider.GetRequiredService<IDmRepository>().FindChannelAsync(auth.UserId, caller) is null) return;
        await hub.SendToUserAsync(auth.Space.Id, caller, WsFrames.CallDeclined(auth.UserId, "declined"));
    }

    private async Task HandleCallCancelAsync(AuthInfo auth, JsonElement payload)
    {
        if (!TryGetLong(payload, "callee_id", out var callee) || callee <= 0) return;
        pendingCalls.Clear(auth.Space.Id, callee, auth.UserId); // caller hung up before the offline callee saw it
        // Only a call this caller actually placed, and is still ringing, can be cancelled. A cancel
        // is a VoIP push too, which iOS must show as a call — unchecked, it rang phones by itself.
        if (!ringing.TryRemove((auth.Space.Id, auth.UserId, callee), out var until) || until < DateTimeOffset.UtcNow) return;
        await hub.SendToUserAsync(auth.Space.Id, callee, WsFrames.CallCancelled(auth.UserId));
        // A phone woken by the call push is still ringing and has no socket to hear that on.
        if (!hub.IsOnline(auth.Space.Id, callee))
            pushNotifier.QueueCall(auth.Space, callee,
                new CallPush(CallIdOf(auth.UserId, callee), auth.UserId, auth.Username, auth.Avatar, 0, Cancelled: true));
    }

    /// <summary>
    /// Names a call so a later cancellation can be matched to the ringing it should stop. Derived
    /// rather than stored: the two ends never need to agree on anything the pair of user ids does
    /// not already say, and a call this pair placed earlier is over by the time another begins.
    /// </summary>
    private static string CallIdOf(long callerId, long calleeId) =>
        $"{callerId}-{calleeId}";

    /// <summary>Calls ringing now, (space, caller, callee) → until when; what a cancel may stop.
    /// Entries die with their ring window or the cancel; an answered call's entry just expires.</summary>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<(long Space, long Caller, long Callee), DateTimeOffset> ringing = new();

    // ── Voice (LiveKit) ──────────────────────────────────────────────────────

    /// <summary>
    /// Voice frames must reach (a) everyone viewing the server that OWNS the voice channel and
    /// (b) the channel's participants even while they browse another server (voice survives
    /// switch_server). DM calls (server-less channels) go to participants only. Duplicate
    /// delivery is harmless — voice_state/voice_leave apply idempotently on the client.
    /// </summary>
    private async Task BroadcastVoiceAsync(Space space, long channelId, byte[] frame, CancellationToken ct)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(space);
            var channel = await scope.ServiceProvider.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId, ct);
            if (channel?.ServerId is { } sid)
                await hub.BroadcastToServerAsync(space.Id, sid, frame);
            var participants = await scope.ServiceProvider.GetRequiredService<IVoiceStateRepository>().GetForChannelAsync(channelId, ct);
            foreach (var p in participants)
                await hub.SendToUserAsync(space.Id, p.UserId, frame);
        }
        catch (Exception ex) { logger.LogDebug(ex, "voice broadcast failed for channel {ChannelId}", channelId); }
    }

    private async Task HandleVoiceJoinAsync(AuthInfo auth, Guid connId, JsonElement payload, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        if (!TryGetLong(payload, "channel_id", out var ch) || ch <= 0)
        {
            await send(WsFrames.Error("BAD_REQUEST", "channel_id must be a positive integer"));
            return;
        }
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            // rejoin: the client re-announces a call it is still in (after a reconnect) — see JoinVoiceCommand.
            var rejoin = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("rejoin", out var rj) && rj.ValueKind == JsonValueKind.True;
            var res = await sender.Send(new JoinVoiceCommand(
                ch, auth.UserId, auth.Username, await RoomPermissionsAsync(auth, ch, scope.ServiceProvider, ct), auth.RoleId, VoiceSessionFor(auth, connId), rejoin), ct);
            voiceConnections[(auth.Space.Id, auth.UserId)] = connId;
            if (res.PreviousChannelId is { } prev)
            {
                await BroadcastVoiceAsync(auth.Space, prev, WsFrames.VoiceLeave(prev, auth.UserId), ct);
                // Moving rooms: this connection's session in the old room goes too (see voice_leave).
                DropStaleSessionLater(auth, prev, ILiveKitTokenService.IdentityFor(auth.UserId, VoiceSessionFor(auth, connId)));
            }

            await send(WsFrames.VoiceToken(ch, res.Token, "/livekit", res.Url));
            await BroadcastVoiceAsync(auth.Space, ch, WsFrames.VoiceState(res.JoinerState), ct);
            foreach (var vs in res.ExistingStates)
                await send(WsFrames.VoiceState(vs));
            // Whether this person may record the room — so a client offers the button only to them.
            var canRecord = await CanRecordAsync(auth, ch, scope.ServiceProvider, ct);
            await send(WsFrames.VoiceConfig(ch, res.Quality, res.Bitrate, res.MaxUsers, canRecord));

            // ONE live voice presence per account: the other devices hand the session over.
            // LAST, and it has to stay last — a voice_state about yourself makes a client mark
            // itself joined, so a takeover sent before that broadcast is undone by it.
            await hub.SendToUserExceptAsync(auth.Space.Id, auth.UserId, connId, WsFrames.Serialize(new
            {
                type = "voice_takeover",
                payload = new { channel_id = ch },
            }));
        }
        catch (DomainException ex) { await send(WsFrames.Error(ex.Code, ex.Message)); }
    }

    /// <summary>
    /// A recording starts or stops (W3GWG-25 stage 4). The recording itself happens on the
    /// recorder's computer — the server never sees the media — so what this governs is the
    /// ANNOUNCEMENT: for holders of RecordCalls (or either side of a DM call) it sets "rec" on their
    /// LiveKit sessions in the room, which every participant reads, guests included, and which goes
    /// away by itself if the recorder leaves. The client starts recording only on voice_record_ok.
    /// </summary>
    private async Task HandleVoiceRecordAsync(AuthInfo auth, JsonElement payload, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        if (!TryGetLong(payload, "channel_id", out var ch) || ch <= 0)
        {
            await send(WsFrames.Error("BAD_REQUEST", "channel_id must be a positive integer"));
            return;
        }
        var on = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("on", out var o) && o.ValueKind == JsonValueKind.True;
        await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
        var sp = scope.ServiceProvider;
        if (on && !await CanRecordAsync(auth, ch, sp, ct))
        {
            await send(WsFrames.Error("FORBIDDEN", "you may not record calls here"));
            return;
        }
        var start = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
        var announced = await sp.GetRequiredService<ILiveKitRoomService>().SetUserAttributeAsync(
            ch, auth.UserId, "rec", on ? start : "", ct);
        if (on && !announced)
        {
            await send(WsFrames.Error("NOT_IN_CALL", "join the call before recording it"));
            return;
        }
        var key = (auth.Space.Id, ch, auth.UserId);
        if (on) { recordings[key] = (auth.Space, start); WatchRecordings(); }
        else recordings.TryRemove(key, out _);
        await send(WsFrames.Serialize(new { type = "voice_record_ok", payload = new { channel_id = ch, on } }));
    }

    /// <summary>Recordings announced through voice_record, per (space, room, user) → the start.</summary>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<(long Space, long Channel, long User), (Space Space, string Start)> recordings = new();
    private int recordingWatch;

    /// <summary>
    /// Keeps the "● recording" notice true. 'rec' is a participant attribute, and the token lets a
    /// participant set its own attributes (raised hands use that), so a recorder could clear it right
    /// after voice_record_ok and go on recording with no notice — which the owner ruled nobody may
    /// hide. Every few seconds each announced recording's 'rec' is put back where it was changed;
    /// a recording ends with voice_record off or when the recorder is no longer in the room.
    /// </summary>
    private void WatchRecordings()
    {
        if (Interlocked.Exchange(ref recordingWatch, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            while (true)
            {
                await Task.Delay(TimeSpan.FromSeconds(4));
                foreach (var (key, rec) in recordings.ToArray())
                {
                    try
                    {
                        await using var scope = scopeFactory.CreateAsyncScopeFor(rec.Space);
                        var stillThere = await scope.ServiceProvider.GetRequiredService<ILiveKitRoomService>()
                            .EnsureUserAttributeAsync(key.Channel, key.User, "rec", rec.Start);
                        if (!stillThere) recordings.TryRemove(key, out _);
                    }
                    catch (Exception ex) { logger.LogDebug(ex, "recording notice check failed"); }
                }
            }
        });
    }

    /// <summary>RecordCalls in the ROOM's server — not the one on screen, since someone in a call may
    /// be browsing elsewhere — with the server owner's grant; either side of a DM call.</summary>
    private static async Task<bool> CanRecordAsync(AuthInfo auth, long channelId, IServiceProvider sp, CancellationToken ct)
    {
        var channel = await sp.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId, ct);
        if (channel is null || channel.Type is not ("voice" or "dm")) return false;
        if (channel.ServerId is not { } sid)
            return await sp.GetRequiredService<IDmRepository>().IsParticipantAsync(auth.UserId, channelId, ct);
        // GetEffectiveForServerAsync includes what the caller's role in THAT server grants (owner and
        // server admins record by default).
        var names = await sp.GetRequiredService<IPermissionRepository>().GetEffectiveForServerAsync(auth.UserId, sid, ct);
        return Permissions.Grants(names, Permissions.RecordCalls);
    }

    private async Task HandleVoiceLeaveAsync(AuthInfo auth, Guid connId, CancellationToken ct)
    {
        // Another device has the call now: this one was replaced (the phone's app answers losing its
        // room with a leave), and honouring it cleared the NEW device's seat while it went on talking.
        if (voiceConnections.TryGetValue((auth.Space.Id, auth.UserId), out var voiceConn) && voiceConn != connId) return;
        await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
        var sender = scope.ServiceProvider.GetRequiredService<ISender>();
        var left = await sender.Send(new LeaveVoiceCommand(auth.UserId), ct);
        if (left is not { } channelId) return;
        await BroadcastVoiceAsync(auth.Space, channelId, WsFrames.VoiceLeave(channelId, auth.UserId), ct);
        // The seat is given up, so the media goes with it: a client that sent voice_leave and kept its
        // LiveKit session listened on, invisible in the roster, with a token good for a day.
        DropStaleSessionLater(auth, channelId, ILiveKitTokenService.IdentityFor(auth.UserId, VoiceSessionFor(auth, connId)));
    }

    /// <summary>A while after a connection gave up its seat in <paramref name="channelId"/>, removes the
    /// session it joined with — unless the user is back in that room by then. Later and conditional
    /// on purpose: an honest client disconnects on its own a moment after its leave, and the SAME
    /// connection re-joining gets the SAME identity, so removing at once (awaited in the frame loop)
    /// held the leave broadcast back by LiveKit's 3-5 s RPC timeout — it reached the room after the
    /// re-join and threw the user out of the roster and the key ledger.</summary>
    private void DropStaleSessionLater(AuthInfo auth, long channelId, string identity) =>
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(10));
                await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
                var sp = scope.ServiceProvider;
                if ((await sp.GetRequiredService<IVoiceStateRepository>().GetAsync(auth.UserId))?.ChannelId == channelId) return;
                await sp.GetRequiredService<ILiveKitRoomService>().RemoveIdentityAsync(channelId, identity);
            }
            catch (Exception ex) { logger.LogDebug(ex, "stale voice session check failed"); }
        });

    private async Task HandleVoiceFlagAsync(AuthInfo auth, JsonElement payload, VoiceFlag flag, string key, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        var value = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(key, out var b) && b.ValueKind == JsonValueKind.True;
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            var room = (await scope.ServiceProvider.GetRequiredService<IVoiceStateRepository>().GetAsync(auth.UserId, ct))?.ChannelId ?? 0;
            var state = await sender.Send(new SetVoiceFlagCommand(auth.UserId, flag, value, await RoomPermissionsAsync(auth, room, scope.ServiceProvider, ct), auth.RoleId), ct);
            if (state is not null) await BroadcastVoiceAsync(auth.Space, state.ChannelId, WsFrames.VoiceState(state), ct);
        }
        catch (DomainException ex) { await send(WsFrames.Error(ex.Code, ex.Message)); }
    }

    /// <summary>The caller's permissions in the server the ROOM belongs to. The socket carries the
    /// ACTIVE server's, and voice survives switch_server — so a role held in another server (one of
    /// your own, say) decided connect/speak/video/share in this one. A DM call keeps the socket's.</summary>
    private static async Task<long> RoomPermissionsAsync(AuthInfo auth, long channelId, IServiceProvider sp, CancellationToken ct)
    {
        if (channelId <= 0) return auth.Permissions;
        var channel = await sp.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId, ct);
        if (channel?.ServerId is not { } sid || sid == auth.ServerId) return auth.Permissions;
        return Permissions.ToBits(await sp.GetRequiredService<IPermissionRepository>().GetEffectiveForServerAsync(auth.UserId, sid, ct));
    }

    private async Task HandleVoiceTokenRefreshAsync(AuthInfo auth, Guid connId, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
        var sender = scope.ServiceProvider.GetRequiredService<ISender>();
        var room = (await scope.ServiceProvider.GetRequiredService<IVoiceStateRepository>().GetAsync(auth.UserId, ct))?.ChannelId ?? 0;
        var res = await sender.Send(new RefreshVoiceTokenCommand(auth.UserId, auth.Username, await RoomPermissionsAsync(auth, room, scope.ServiceProvider, ct), auth.RoleId, VoiceSessionFor(auth, connId)), ct);
        if (res is not null) await send(WsFrames.VoiceToken(res.ChannelId, res.Token, "/livekit", res.Url));
        else await send(WsFrames.Error("BAD_REQUEST", "not in voice"));
    }

    // ── Auth + ready ─────────────────────────────────────────────────────────
    private async Task<AuthInfo?> AuthenticateAsync(WebSocket ws, Space space, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(AuthDeadline);

        byte[]? raw;
        try { raw = await ReadFrameAsync(ws, cts.Token); }
        catch { return null; }
        if (raw is null) return null;

        string? token;
        long lastSeq = 0;
        long requestedServer = 0;
        string? deviceId = null;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var t) || t.GetString() != "auth")
            {
                await TrySendAsync(ws, WsFrames.AuthError("first message must be auth"), ct);
                return null;
            }
            if (root.TryGetProperty("payload", out var pl) && pl.ValueKind == JsonValueKind.Object)
            {
                token = pl.TryGetProperty("token", out var tk) ? tk.GetString() : null;
                if (pl.TryGetProperty("last_seq", out var ls) && ls.TryGetInt64(out var lv)) lastSeq = lv;
                if (pl.TryGetProperty("server_id", out var sv) && sv.TryGetInt64(out var svv)) requestedServer = svv;
                if (pl.TryGetProperty("device_id", out var dv) && dv.ValueKind == JsonValueKind.String) deviceId = ParseDeviceId(dv.GetString());
            }
            else token = null;
        }
        catch
        {
            await TrySendAsync(ws, WsFrames.AuthError("invalid message"), ct);
            return null;
        }
        if (string.IsNullOrEmpty(token))
        {
            await TrySendAsync(ws, WsFrames.AuthError("missing token"), ct);
            return null;
        }

        // The token service is space-scoped (it checks the token's space claim), so it is
        // resolved inside this connection's space, not captured by this singleton.
        long? uid;
        await using (var jwtScope = scopeFactory.CreateAsyncScopeFor(space))
            uid = jwtScope.ServiceProvider.GetRequiredService<IJwtTokenService>().Validate(token);
        if (uid is null)
        {
            await TrySendAsync(ws, WsFrames.AuthError("invalid token"), ct);
            return null;
        }

        await using var scope = scopeFactory.CreateAsyncScopeFor(space);

        // Session revocation check — mirrors JwtCurrentUserMiddleware: logout/kick delete the
        // session row, which must also close the door on new WebSocket connections.
        var sessionRepo = scope.ServiceProvider.GetRequiredService<ISessionRepository>();
        var sessionHash = Outcome.Shared.Abstractions.Security.TokenHash.Sha256(token);
        var wsSession = await sessionRepo.GetByTokenHashAsync(sessionHash, ct);
        if (wsSession is null || wsSession.ExpiresAt <= DateTime.UtcNow)
        {
            await TrySendAsync(ws, WsFrames.AuthError("session expired or revoked"), ct);
            return null;
        }

        var users = scope.ServiceProvider.GetRequiredService<IUserRepository>();
        var permissions = scope.ServiceProvider.GetRequiredService<IPermissionRepository>();
        var settings = scope.ServiceProvider.GetRequiredService<ISettingsRepository>();
        var serverRepo = scope.ServiceProvider.GetRequiredService<IServerRepository>();

        var user = await users.GetByIdAsync(uid.Value, ct);
        if (user is null)
        {
            await TrySendAsync(ws, WsFrames.AuthError("user not found"), ct);
            return null;
        }
        if (user.Banned && (user.BanExpires is null || user.BanExpires > DateTime.UtcNow))
        {
            await TrySendAsync(ws, WsFrames.Error("BANNED", "you are banned"), ct);
            return null;
        }
        var serverName = await settings.GetAsync("server_name", ct) ?? serverOptions.Value.Name;
        var motd = await settings.GetAsync("motd", ct) ?? "";

        // Active server (tenant): the requested one if the user is a member, else their primary. A user
        // who belongs to NO server (e.g. just registered without an invite) gets serverId 0 — no tenant,
        // an empty READY, no presence anywhere. They land in the Home view and create/join a server.
        var activeServer = requestedServer > 0 && await serverRepo.IsMemberAsync(requestedServer, user.Id, ct)
            ? requestedServer
            : await serverRepo.GetFirstForUserAsync(user.Id, ct);

        // The role INSIDE the active server, and the permissions there: the space role's claims plus
        // the fixed set that server role adds (ServerRoles.Grant) — the same computation the HTTP
        // middleware does: the socket and the REST API answering differently for one person is a bug
        // that only shows up as "muting works after a reload".
        var serverRole = await serverRepo.GetServerRoleAsync(activeServer, user.Id, ct);
        var permBits = Permissions.ToBits(await permissions.GetEffectiveForServerAsync(user.Id, activeServer, ct));
        // Administrator only ever comes from the SPACE role (InstanceGlobalPerms keeps it out of any
        // server grant), so this is "may open /admin".
        var spaceAdmin = (permBits & Outcome.Domain.Permissions.Permission.Administrator) != 0;

        return new AuthInfo(user.Id, user.Username, user.Avatar, user.RoleId,
            Outcome.Domain.Permissions.ServerRoles.Name(serverRole), permBits, serverName, motd, lastSeq, activeServer, space, deviceId,
            SpaceAdmin: spaceAdmin, SessionHash: sessionHash);
    }

    /// <summary>Persist "everything in this channel is read" and fan the marker out: to EVERY
    /// device of this user (badges clear everywhere) AND to the chat's other participants —
    /// their sent messages flip to ✓✓. The user_id in the frame tells the receivers whose
    /// marker moved.</summary>
    private async Task HandleReadAsync(AuthInfo auth, long channelId, CancellationToken ct)
    {
        long lastId;
        string channelType;
        long? channelServerId;
        IReadOnlyList<long> dmParticipants = Array.Empty<long>();
        await using (var scope = scopeFactory.CreateAsyncScopeFor(auth.Space))
        {
            try
            {
                var channel = await scope.ServiceProvider.GetRequiredService<IChannelRepository>().GetByIdAsync(channelId, ct);
                if (channel is null) return;
                channelType = channel.Type;
                channelServerId = channel.ServerId;
                if (channelType == "dm")
                {
                    dmParticipants = await scope.ServiceProvider.GetRequiredService<IDmRepository>().GetParticipantIdsAsync(channelId, ct);
                    // Only one's own conversations: any channel id used to be accepted, which told a
                    // stranger the newest message id of someone else's DM and sent its two
                    // participants a read receipt from them.
                    if (!dmParticipants.Contains(auth.UserId)) return;
                }
                else if (channel.ServerId is not { } sid
                         || !await scope.ServiceProvider.GetRequiredService<IServerRepository>().IsMemberAsync(sid, auth.UserId, ct))
                    return;
                lastId = await scope.ServiceProvider.GetRequiredService<IReadStateRepository>()
                    .MarkReadAsync(auth.UserId, channelId, ct);
            }
            catch (Exception)
            {
                return; // unknown channel id — nothing to mark
            }
        }
        var frame = WsFrames.Serialize(new
        {
            type = "read_state",
            payload = new { channel_id = channelId, user_id = auth.UserId, last_message_id = lastId },
        });
        // Own devices always (they may be viewing another server right now).
        await hub.SendToUserAsync(auth.Space.Id, auth.UserId, frame);
        if (channelType == "dm")
        {
            foreach (var pid in dmParticipants.Where(p => p != auth.UserId))
                await hub.SendToUserAsync(auth.Space.Id, pid, frame);
        }
        else
        {
            await hub.BroadcastToServerAsync(auth.Space.Id, channelServerId ?? auth.ServerId, frame);
        }
    }

    /// <summary>Persist "I played this voice message": echo to the user's other devices, and
    /// tell the clip's AUTHOR their voice was heard (the sender-side dot goes out).</summary>
    private async Task HandleListenAsync(AuthInfo auth, string attachmentId, CancellationToken ct)
    {
        long? authorId = null;
        await using (var scope = scopeFactory.CreateAsyncScopeFor(auth.Space))
        {
            await scope.ServiceProvider.GetRequiredService<IVoiceListenRepository>()
                .MarkAsync(auth.UserId, attachmentId, ct);
            var att = await scope.ServiceProvider.GetRequiredService<IAttachmentRepository>().GetByIdAsync(attachmentId, ct);
            if (att?.MessageId is { } mid)
                authorId = (await scope.ServiceProvider.GetRequiredService<IMessageRepository>().GetByIdAsync(mid, ct))?.UserId;
        }
        await hub.SendToUserAsync(auth.Space.Id, auth.UserId, WsFrames.Serialize(new
        {
            type = "voice_listened",
            payload = new { attachment_id = attachmentId },
        }));
        if (authorId is { } aid && aid != auth.UserId)
        {
            await hub.SendToUserAsync(auth.Space.Id, aid, WsFrames.Serialize(new
            {
                type = "voice_listened_peer",
                payload = new { attachment_id = attachmentId },
            }));
        }
    }

    private async Task<byte[]> BuildReadyAsync(AuthInfo auth, CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
        var channels = await scope.ServiceProvider.GetRequiredService<IChannelRepository>().ListAsync(auth.ServerId, ct);
        var members = await scope.ServiceProvider.GetRequiredService<IUserRepository>().ListMembersForServerAsync(auth.ServerId, ct);
        var roles = await scope.ServiceProvider.GetRequiredService<IRoleRepository>().ListAsync(ct);
        var mutedChannels = await scope.ServiceProvider.GetRequiredService<IChannelMuteRepository>().ListForUserAsync(auth.UserId, ct);
        var readRepo = scope.ServiceProvider.GetRequiredService<IReadStateRepository>();
        var channelIds = channels.Select(c => c.Id).ToList();
        var unreadByChannel = await readRepo.UnreadCountsAsync(auth.UserId, channelIds, ct);
        var otherReadByChannel = await readRepo.MaxOtherReadAsync(auth.UserId, channelIds, ct);

        var channelPayloads = channels.Select(ch => new
        {
            id = ch.Id,
            name = ch.Name,
            type = ch.Type,
            category = ch.Category ?? "",
            position = ch.Position,
            // A voice room's own text chat (W3GWG-25): where its chat panel and recordings go.
            chat_channel_id = ch.ChatChannelId,
            unread_count = unreadByChannel.TryGetValue(ch.Id, out var uc) ? uc : 0,
            last_message_id = 0L,
            read_by_others = otherReadByChannel.TryGetValue(ch.Id, out var ro) ? ro : 0L,
        }).ToArray();

        // `role` is the member's role INSIDE this server (owner / admin / moderator / member), as in
        // auth_ok and member_join. It used to be the SPACE role here and the server role in
        // member_join, so badges flipped on every switch and a server's creator read "member".
        var serverRoles = await scope.ServiceProvider.GetRequiredService<IServerRepository>().ServerRolesAsync(auth.ServerId, ct);
        var memberPayloads = members.Select(m => new
        {
            id = m.Id, username = m.Username, avatar = m.Avatar, status = m.Status,
            role = Outcome.Domain.Permissions.ServerRoles.Name(serverRoles.TryGetValue(m.Id, out var sr) ? sr : Outcome.Domain.Permissions.ServerRole.Member),
            created_at = m.CreatedAt, // the "member since" line on a profile
        }).ToArray();

        var rolePayloads = roles.Select(r => new
        {
            id = r.Id, name = r.Name, color = r.Color, permissions = r.Permissions, position = r.Position,
        }).ToArray();

        var voiceStates = await scope.ServiceProvider.GetRequiredService<IVoiceStateRepository>().GetForServerAsync(auth.ServerId, auth.UserId, ct);
        var voicePayloads = voiceStates.Select(v => new
        {
            channel_id = v.ChannelId, user_id = v.UserId, username = v.Username,
            muted = v.Muted, deafened = v.Deafened, speaking = v.Speaking, camera = v.Camera, screenshare = v.Screenshare,
        })
        // Guests (negative ids) live only in LiveKit, not in voice_states — splice them in from the
        // webhook-fed registry so a freshly-connected client's sidebar shows them without joining.
        .Concat(channels.Where(ch => ch.Type == "voice").SelectMany(ch =>
            guestPresence.Snapshot(auth.Space.Id, ch.Id).Select(g => new
            {
                channel_id = ch.Id, user_id = g.Id, username = g.Name,
                muted = false, deafened = false, speaking = false, camera = false, screenshare = false,
            })))
        .ToArray();

        return WsFrames.Serialize(new
        {
            type = "ready",
            payload = new
            {
                channels = channelPayloads,
                members = memberPayloads,
                voice_states = voicePayloads,
                roles = rolePayloads,
                dm_channels = Array.Empty<object>(),
                muted_channels = mutedChannels,
                server_name = auth.ServerName,
                motd = auth.Motd,
                // The receiver's own standing: their role in this server and whether they administer
                // the space (opens /admin). Clients gate on these, never on role NAMES.
                server_role = auth.Role,
                space_admin = auth.SpaceAdmin,
            },
        });
    }

    private async Task UpdateStatusAsync(Space space, long userId, string status, CancellationToken ct)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(space);
            await scope.ServiceProvider.GetRequiredService<IUserRepository>().UpdateStatusAsync(userId, status, ct);
        }
        catch (Exception ex) { logger.LogDebug(ex, "failed to update status for user {UserId}", userId); }
    }

    /// <summary>How long a voice participant may stay in the roster with no live socket.
    /// Mobile clients drop and re-open the WS constantly (backgrounding, network flips)
    /// while their LiveKit media keeps flowing; removing the voice_states row on the first
    /// disconnect turned them into GHOSTS — audible in the room, missing from every
    /// roster/existing-states snapshot. The reconnect re-announces the join.</summary>
    private static readonly TimeSpan VoiceDisconnectGrace = TimeSpan.FromSeconds(15);

    private async Task LeaveVoiceOnDisconnectAsync(Space space, long userId)
    {
        try
        {
            // Grace window: if the user reconnects (mobile WS churn), keep their voice
            // presence — the client re-announces voice_join right after auth anyway.
            await Task.Delay(VoiceDisconnectGrace);
            if (hub.IsOnline(space.Id, userId)) return;
            await using var scope = scopeFactory.CreateAsyncScopeFor(space);
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            var left = await sender.Send(new LeaveVoiceCommand(userId), CancellationToken.None);
            if (left is { } channelId) await BroadcastVoiceAsync(space, channelId, WsFrames.VoiceLeave(channelId, userId), CancellationToken.None);
        }
        catch (Exception ex) { logger.LogDebug(ex, "voice cleanup on disconnect failed for {UserId}", userId); }
    }

    // ── Low-level frame I/O ──────────────────────────────────────────────────
    private static async Task<byte[]?> ReadFrameAsync(WebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[8192];
        using var ms = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await ws.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            ms.Write(buffer, 0, result.Count);
            if (ms.Length > MaxFrameBytes) return null;
        } while (!result.EndOfMessage);
        return ms.ToArray();
    }

    private static async Task TrySendAsync(WebSocket ws, byte[] msg, CancellationToken ct)
    {
        try { if (ws.State == WebSocketState.Open) await ws.SendAsync(msg, WebSocketMessageType.Text, true, ct); }
        catch { /* ignore */ }
    }

    private static async Task CloseQuietly(WebSocket ws)
    {
        try { if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived) await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); }
        catch { /* ignore */ }
    }

    private static bool TryGetLong(JsonElement payload, string name, out long value)
    {
        value = 0;
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty(name, out var el)) return false;
        switch (el.ValueKind)
        {
            case JsonValueKind.Number when el.TryGetInt64(out var n): value = n; return true;
            case JsonValueKind.String when long.TryParse(el.GetString(), out var s): value = s; return true;
            default: return false;
        }
    }
}
