using System.Text.Json;
using System.Text.Json.Serialization;
using Outcome.Application.Realtime;
using Outcome.Application.Voice;

namespace Outcome.Api.Realtime;

/// <summary>Builders for outbound WebSocket frames. Property names are written verbatim
/// (already snake_case) to exactly match the wire protocol.</summary>
internal static class WsFrames
{
    private static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public static byte[] Serialize(object frame) => JsonSerializer.SerializeToUtf8Bytes(frame, Opts);

    public static byte[] AuthError(string message) =>
        Serialize(new { type = "auth_error", payload = new { message } });

    public static byte[] Error(string code, string message) =>
        Serialize(new { type = "error", payload = new { code = NormalizeCode(code), message } });

    /// <summary>Maps server DomainException codes onto the client's WsErrorCode union so the
    /// dispatcher recognizes them instead of silently dropping unknown codes.</summary>
    private static string NormalizeCode(string code) => code switch
    {
        "BANNED" or "FORBIDDEN" or "NOT_FOUND" or "RATE_LIMITED" or "INVALID_INPUT"
            or "SERVER_ERROR" or "CHANNEL_FULL" or "VOICE_ERROR" or "VIDEO_LIMIT"
            or "CONTENT_BLOCKED" => code,
        "BAD_REQUEST" or "CONFLICT" or "INVALID_CREDENTIALS" => "INVALID_INPUT",
        "ALREADY_JOINED" => "VOICE_ERROR",
        "UNAUTHORIZED" => "FORBIDDEN",
        _ => "SERVER_ERROR",
    };

    public static byte[] Pong() => Serialize(new { type = "pong" });

    /// <summary>Marks the end of the reconnect replay burst — the client drops dedup mode here.</summary>
    public static byte[] ReplayDone() =>
        Serialize(new { type = "replay_done", payload = new { } });

    public static byte[] AuthOk(long id, string username, string? avatar, string role, string serverName, string motd) =>
        Serialize(new { type = "auth_ok", payload = new { user = new { id, username, avatar, role }, server_name = serverName, motd } });

    public static byte[] ChatSendOk(string? reqId, long messageId, DateTime timestamp) =>
        Serialize(new { type = "chat_send_ok", id = reqId, payload = new { message_id = messageId, timestamp } });

    public static byte[] ChatMessage(long id, long channelId, long userId, string username, string? avatar, string role, string content, long? replyTo, DateTime timestamp, long seq, IReadOnlyList<AttachmentDto>? attachments = null, string? forwardedFrom = null) =>
        Serialize(new
        {
            type = "chat_message",
            seq,
            payload = new
            {
                id,
                channel_id = channelId,
                user = new { id = userId, username, avatar, role },
                content,
                reply_to = replyTo,
                forwarded_from = forwardedFrom,
                timestamp,
                attachments = (attachments ?? Array.Empty<AttachmentDto>())
                    .Select(a => new { id = a.Id, filename = a.Filename, size = a.Size, mime = a.Mime, url = a.Url, width = a.Width, height = a.Height, duration_ms = a.DurationMs, waveform = a.Waveform })
                    .ToArray(),
                reactions = Array.Empty<object>(),
                pinned = false,
            },
        });

    public static byte[] Presence(long userId, string status) =>
        Serialize(new { type = "presence", payload = new { user_id = userId, status } });

    public static byte[] MemberJoin(long id, string username, string? avatar, string role) =>
        Serialize(new { type = "member_join", payload = new { user = new { id, username, avatar, role } } });

    public static byte[] MemberLeave(long userId) =>
        Serialize(new { type = "member_leave", payload = new { user_id = userId } });

    public static byte[] MemberBan(long userId) =>
        Serialize(new { type = "member_ban", payload = new { user_id = userId } });

    /// <summary>A user deleted their account: clients drop the member and mark their messages deleted
    /// (so replies to them render a "Deleted message" placeholder).</summary>
    public static byte[] MemberDelete(long userId) =>
        Serialize(new { type = "member_delete", payload = new { user_id = userId } });

    public static byte[] MemberUpdate(long userId, string role) =>
        Serialize(new { type = "member_update", payload = new { user_id = userId, role } });

    public static byte[] ChannelCreate(long id, string name, string type, string? category, int position) =>
        Serialize(new { type = "channel_create", payload = new { id, name, type, category, position } });

    public static byte[] ChannelUpdate(long id, string name, int position) =>
        Serialize(new { type = "channel_update", payload = new { id, name, position } });

    public static byte[] ChannelDelete(long id) =>
        Serialize(new { type = "channel_delete", payload = new { id } });

    public static byte[] Typing(long channelId, long userId, string username) =>
        Serialize(new { type = "typing", payload = new { channel_id = channelId, user_id = userId, username } });

    public static byte[] ChatEdited(long messageId, long channelId, string content, DateTime editedAt) =>
        Serialize(new { type = "chat_edited", payload = new { message_id = messageId, channel_id = channelId, content, edited_at = editedAt } });

    /// <param name="purged">True for DMs: the row is gone, so clients must DROP the message
    /// rather than render a "deleted" tombstone for something that no longer exists.</param>
    public static byte[] ChatDeleted(long messageId, long channelId, bool purged = false) =>
        Serialize(new { type = "chat_deleted", payload = new { message_id = messageId, channel_id = channelId, purged } });

    public static byte[] ReactionUpdate(long messageId, long channelId, string emoji, long userId, string action) =>
        Serialize(new { type = "reaction_update", payload = new { message_id = messageId, channel_id = channelId, emoji, user_id = userId, action } });

    // ── voice ────────────────────────────────────────────────────────────────
    public static byte[] VoiceToken(long channelId, string token, string url, string directUrl) =>
        Serialize(new { type = "voice_token", payload = new { channel_id = channelId, token, url, direct_url = directUrl } });

    public static byte[] VoiceConfig(long channelId, string quality, int bitrate, int maxUsers) =>
        Serialize(new
        {
            type = "voice_config",
            payload = new { channel_id = channelId, quality, bitrate, max_users = maxUsers, threshold_mode = "top_speakers", mixing_threshold = 0, top_speakers = 5 },
        });

    public static byte[] VoiceState(VoiceStateDto v) =>
        Serialize(new
        {
            type = "voice_state",
            payload = new
            {
                channel_id = v.ChannelId, user_id = v.UserId, username = v.Username,
                muted = v.Muted, deafened = v.Deafened, speaking = v.Speaking, camera = v.Camera, screenshare = v.Screenshare,
            },
        });

    public static byte[] VoiceLeave(long channelId, long userId) =>
        Serialize(new { type = "voice_leave", payload = new { channel_id = channelId, user_id = userId } });

    // ── friends ────────────────────────────────────────────────────────────────
    public static byte[] FriendRequest(long id, string username, string? avatar, string status) =>
        Serialize(new { type = "friend_request", payload = new { from = new { id, username, avatar, status } } });

    public static byte[] FriendAccepted(long id, string username, string? avatar, string status) =>
        Serialize(new { type = "friend_accepted", payload = new { user = new { id, username, avatar, status } } });

    public static byte[] FriendRemoved(long userId) =>
        Serialize(new { type = "friend_removed", payload = new { user_id = userId } });

    // ── direct call signaling (relay only; media is LiveKit) ─────────────────────
    public static byte[] CallIncoming(long callerId, string callerName, string? callerAvatar, long channelId) =>
        Serialize(new { type = "call_incoming", payload = new { caller = new { id = callerId, username = callerName, avatar = callerAvatar }, channel_id = channelId } });

    public static byte[] CallAccepted(long calleeId, long channelId) =>
        Serialize(new { type = "call_accepted", payload = new { callee_id = calleeId, channel_id = channelId } });

    public static byte[] CallDeclined(long calleeId, string reason) =>
        Serialize(new { type = "call_declined", payload = new { callee_id = calleeId, reason } });

    public static byte[] CallCancelled(long callerId) =>
        Serialize(new { type = "call_cancelled", payload = new { caller_id = callerId } });
}
