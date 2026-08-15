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
    GuestPresence guestPresence,
    PushNotifier pushNotifier,
    ILogger<WebSocketHandler> logger)
{
    // How long a call rings an offline callee before it's considered missed (kept in step with the
    // web client's RING_TIMEOUT_MS so a parked call can't pop after the caller already gave up).
    private static readonly TimeSpan RingWindow = TimeSpan.FromSeconds(45);
    private const int MaxFrameBytes = 1 << 20; // 1 MB
    private static readonly TimeSpan AuthDeadline = TimeSpan.FromSeconds(10);

    private sealed record AuthInfo(
        long UserId, string Username, string? Avatar, long RoleId, string Role, long Permissions, string ServerName, string Motd, long LastSeq, long ServerId,
        Space Space);

    /// <param name="space">Resolved from the upgrade request's Host and pinned for the whole
    /// connection — a socket cannot wander between tenants mid-stream.</param>
    public async Task RunAsync(WebSocket ws, Space space, CancellationToken ct)
    {
        var auth = await AuthenticateAsync(ws, space, ct);
        if (auth is null) { await CloseQuietly(ws); return; }

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

        await Send(WsFrames.AuthOk(auth.UserId, auth.Username, auth.Avatar, auth.Role, auth.ServerName, auth.Motd));
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

        try
        {
            while (ws.State == WebSocketState.Open)
            {
                var raw = await ReadFrameAsync(ws, cct);
                if (raw is null) break;
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

    // ── Dispatch ─────────────────────────────────────────────────────────────
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

            case "switch_server":
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
                await HandleVoiceLeaveAsync(auth, ct);
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
                if (TryGetLong(payload, "channel_id", out var typingCh))
                    await hub.BroadcastToServerAsync(auth.Space.Id, auth.ServerId, WsFrames.Typing(typingCh, auth.UserId, auth.Username));
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
                        ? s.GetString() ?? "online" : "online";
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

        var roles = scope.ServiceProvider.GetRequiredService<IRoleRepository>();
        var permissions = scope.ServiceProvider.GetRequiredService<IPermissionRepository>();

        // Per-server role + permissions for the newly-active tenant (mirrors AuthenticateAsync).
        var effectiveRole = await serverRepo.GetMemberRoleAsync(newServer, auth.UserId, ct) ?? auth.RoleId;
        var permBits = Permissions.ToBits(await permissions.GetEffectiveForServerAsync(auth.UserId, newServer, ct));
        var role = await roles.GetByIdAsync(effectiveRole, ct);
        if ((permBits & Outcome.Domain.Permissions.Permission.Administrator) == 0)
        {
            var info = await serverRepo.GetAsync(newServer, ct);
            if (info is not null && info.OwnerId == auth.UserId)
                permBits |= Outcome.Domain.Permissions.Permission.ManageChannels
                          | Outcome.Domain.Permissions.Permission.ManageInvites
                          | Outcome.Domain.Permissions.Permission.ManageMessages
                          | Outcome.Domain.Permissions.Permission.KickMembers;
        }

        var newAuth = auth with
        {
            ServerId = newServer,
            RoleId = effectiveRole,
            Role = (role?.Name ?? "member").ToLowerInvariant(),
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
            // The first picture, if there is one, rides along so the banner can show it instead of
            // the word "attachment". The URL is already signed and already expiring — it is the
            // same one the app would fetch, handed over a little earlier.
            var pushImage = created.Attachments
                .FirstOrDefault(a => a.Mime.StartsWith("image/", StringComparison.Ordinal))?.Url;
            pushNotifier.QueueMessage(auth.Space, channelId, auth.UserId, auth.Username, created.Content,
                pushImage,
                created.DmParticipantIds, created.DmParticipantIds is null ? created.ServerId ?? auth.ServerId : null);
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
            await hub.BroadcastToServerAsync(auth.Space.Id, auth.ServerId, WsFrames.ChatEdited(res.MessageId, res.ChannelId, res.Content, res.EditedAt));
        }
        catch (DomainException ex)
        {
            await send(WsFrames.Error(ex.Code, ex.Message));
        }
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
            await hub.BroadcastToServerAsync(auth.Space.Id, auth.ServerId, WsFrames.ReactionUpdate(res.MessageId, res.ChannelId, res.Emoji, res.UserId, res.Action));
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
        }
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
        await hub.SendToUserAsync(auth.Space.Id, caller, WsFrames.CallAccepted(auth.UserId, channelId));
    }

    private async Task HandleCallDeclineAsync(AuthInfo auth, JsonElement payload)
    {
        if (!TryGetLong(payload, "caller_id", out var caller) || caller <= 0) return;
        await hub.SendToUserAsync(auth.Space.Id, caller, WsFrames.CallDeclined(auth.UserId, "declined"));
    }

    private async Task HandleCallCancelAsync(AuthInfo auth, JsonElement payload)
    {
        if (!TryGetLong(payload, "callee_id", out var callee) || callee <= 0) return;
        pendingCalls.Clear(auth.Space.Id, callee, auth.UserId); // caller hung up before the offline callee saw it
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
            var res = await sender.Send(new JoinVoiceCommand(
                ch, auth.UserId, auth.Username, auth.Permissions, auth.RoleId, connId.ToString("N")[..8]), ct);
            if (res.PreviousChannelId is { } prev)
                await BroadcastVoiceAsync(auth.Space, prev, WsFrames.VoiceLeave(prev, auth.UserId), ct);

            await send(WsFrames.VoiceToken(ch, res.Token, "/livekit", res.Url));
            await BroadcastVoiceAsync(auth.Space, ch, WsFrames.VoiceState(res.JoinerState), ct);
            foreach (var vs in res.ExistingStates)
                await send(WsFrames.VoiceState(vs));
            await send(WsFrames.VoiceConfig(ch, res.Quality, res.Bitrate, res.MaxUsers));

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

    private async Task HandleVoiceLeaveAsync(AuthInfo auth, CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
        var sender = scope.ServiceProvider.GetRequiredService<ISender>();
        var left = await sender.Send(new LeaveVoiceCommand(auth.UserId), ct);
        if (left is { } channelId) await BroadcastVoiceAsync(auth.Space, channelId, WsFrames.VoiceLeave(channelId, auth.UserId), ct);
    }

    private async Task HandleVoiceFlagAsync(AuthInfo auth, JsonElement payload, VoiceFlag flag, string key, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        var value = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(key, out var b) && b.ValueKind == JsonValueKind.True;
        try
        {
            await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
            var sender = scope.ServiceProvider.GetRequiredService<ISender>();
            var state = await sender.Send(new SetVoiceFlagCommand(auth.UserId, flag, value, auth.Permissions, auth.RoleId), ct);
            if (state is not null) await BroadcastVoiceAsync(auth.Space, state.ChannelId, WsFrames.VoiceState(state), ct);
        }
        catch (DomainException ex) { await send(WsFrames.Error(ex.Code, ex.Message)); }
    }

    private async Task HandleVoiceTokenRefreshAsync(AuthInfo auth, Guid connId, Func<byte[], ValueTask> send, CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScopeFor(auth.Space);
        var sender = scope.ServiceProvider.GetRequiredService<ISender>();
        var res = await sender.Send(new RefreshVoiceTokenCommand(auth.UserId, auth.Username, auth.Permissions, auth.RoleId, connId.ToString("N")[..8]), ct);
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
        var wsSession = await sessionRepo.GetByTokenHashAsync(Outcome.Shared.Abstractions.Security.TokenHash.Sha256(token), ct);
        if (wsSession is null || wsSession.ExpiresAt <= DateTime.UtcNow)
        {
            await TrySendAsync(ws, WsFrames.AuthError("session expired or revoked"), ct);
            return null;
        }

        var users = scope.ServiceProvider.GetRequiredService<IUserRepository>();
        var roles = scope.ServiceProvider.GetRequiredService<IRoleRepository>();
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

        // Per-server role: the user's role IN the active server (server_members.role_id) if assigned,
        // else their global role. Permissions are resolved for the active server (a per-server role adds
        // server-scoped perms; instance-global powers come only from the global role).
        var effectiveRole = await serverRepo.GetMemberRoleAsync(activeServer, user.Id, ct) ?? user.RoleId;
        var permBits = Permissions.ToBits(await permissions.GetEffectiveForServerAsync(user.Id, activeServer, ct));
        var role = await roles.GetByIdAsync(effectiveRole, ct);

        // The owner of the active server is an admin WITHIN it — server-scoped manage perms only (NOT the
        // global Administrator bypass), so moderation stays inside their tenant and can't reach roles/other servers.
        if ((permBits & Outcome.Domain.Permissions.Permission.Administrator) == 0)
        {
            var info = await serverRepo.GetAsync(activeServer, ct);
            if (info is not null && info.OwnerId == user.Id)
                permBits |= Outcome.Domain.Permissions.Permission.ManageChannels
                          | Outcome.Domain.Permissions.Permission.ManageInvites
                          | Outcome.Domain.Permissions.Permission.ManageMessages
                          | Outcome.Domain.Permissions.Permission.KickMembers
                          | Outcome.Domain.Permissions.Permission.MuteMembers
                          | Outcome.Domain.Permissions.Permission.ManageRoles
                          | Outcome.Domain.Permissions.Permission.ManageServer
                          | Outcome.Domain.Permissions.Permission.ViewAuditLog;
        }

        return new AuthInfo(user.Id, user.Username, user.Avatar, effectiveRole,
            (role?.Name ?? "member").ToLowerInvariant(), permBits, serverName, motd, lastSeq, activeServer, space);
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
                    dmParticipants = await scope.ServiceProvider.GetRequiredService<IDmRepository>().GetParticipantIdsAsync(channelId, ct);
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
            unread_count = unreadByChannel.TryGetValue(ch.Id, out var uc) ? uc : 0,
            last_message_id = 0L,
            read_by_others = otherReadByChannel.TryGetValue(ch.Id, out var ro) ? ro : 0L,
        }).ToArray();

        // The client keys members by role NAME (lowercased), matching auth_ok.
        var roleNameById = roles.ToDictionary(r => r.Id, r => r.Name.ToLowerInvariant());
        var memberPayloads = members.Select(m => new
        {
            id = m.Id, username = m.Username, avatar = m.Avatar, status = m.Status,
            role = roleNameById.TryGetValue(m.RoleId, out var roleName) ? roleName : "member",
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
