using System.Linq;
using Livekit.Server.Sdk.Dotnet;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Infrastructure.Configuration;
using Outcome.Infrastructure.Tenancy;

namespace Outcome.Infrastructure.Voice;

internal static class LiveKitUrlHelper
{
    public static string ToHttp(string url) =>
        url.StartsWith("wss://") ? "https://" + url[6..]
        : url.StartsWith("ws://") ? "http://" + url[5..]
        : url;

    public static string Internal(VoiceOptions o) =>
        string.IsNullOrEmpty(o.LiveKitInternalUrl) ? o.LiveKitUrl : o.LiveKitInternalUrl;
}

public sealed class LiveKitRoomService : ILiveKitRoomService
{
    private readonly RoomServiceClient? _client;

    private readonly ICurrentSpace space;

    public LiveKitRoomService(IOptions<VoiceOptions> options, ICurrentSpace currentSpace)
    {
        space = currentSpace;
        var o = options.Value;
        if (!string.IsNullOrEmpty(o.LiveKitApiKey) && !string.IsNullOrEmpty(o.LiveKitApiSecret))
        {
            var host = LiveKitUrlHelper.ToHttp(LiveKitUrlHelper.Internal(o));
            _client = new RoomServiceClient(host, o.LiveKitApiKey, o.LiveKitApiSecret);
        }
    }

    public async Task<bool> IsHealthyAsync(CancellationToken ct = default)
    {
        if (_client is null) return false;
        try { await _client.ListRooms(new ListRoomsRequest()); return true; }
        catch { return false; }
    }

    // Identities are "user-{id}" (legacy, pre-session-suffix) or "user-{id}.{session}".
    private static bool IsUserSession(string identity, long userId) =>
        identity == $"user-{userId}" || identity.StartsWith($"user-{userId}.", StringComparison.Ordinal);

    public Task RemoveParticipantAsync(long channelId, long userId, CancellationToken ct = default) =>
        RemoveUserSessionsAsync(channelId, userId, keepIdentity: null);

    public Task RemoveOtherUserSessionsAsync(long channelId, long userId, string keepIdentity, CancellationToken ct = default) =>
        RemoveUserSessionsAsync(channelId, userId, keepIdentity);

    private async Task RemoveUserSessionsAsync(long channelId, long userId, string? keepIdentity)
    {
        if (_client is null) return;
        var room = LiveKitRooms.Name(space.Space.Id, channelId);
        try
        {
            var res = await _client.ListParticipants(new ListParticipantsRequest { Room = room });
            foreach (var p in res.Participants)
            {
                if (!IsUserSession(p.Identity, userId) || p.Identity == keepIdentity) continue;
                try { await _client.RemoveParticipant(new RoomParticipantIdentity { Room = room, Identity = p.Identity }); }
                catch { /* one session failing must not stop the rest */ }
            }
        }
        catch { /* room may not exist (nobody connected) — nothing to remove */ }
    }

    public async Task<bool> HasUserSessionAsync(long channelId, long userId, CancellationToken ct = default)
    {
        if (_client is null) return false;
        try
        {
            var res = await _client.ListParticipants(new ListParticipantsRequest { Room = LiveKitRooms.Name(space.Space.Id, channelId) });
            return res.Participants.Any(p => IsUserSession(p.Identity, userId));
        }
        catch { return false; }
    }

    public async Task RemoveGuestsAsync(long channelId, CancellationToken ct = default)
    {
        if (_client is null) return;
        var room = LiveKitRooms.Name(space.Space.Id, channelId);
        try
        {
            var res = await _client.ListParticipants(new ListParticipantsRequest { Room = room });
            foreach (var p in res.Participants)
            {
                if (!p.Identity.StartsWith("guest-", StringComparison.Ordinal)) continue;
                try { await _client.RemoveParticipant(new RoomParticipantIdentity { Room = room, Identity = p.Identity }); }
                catch { /* one guest failing must not stop the rest */ }
            }
        }
        catch { /* room may not exist (nobody connected) — nothing to kick */ }
    }

    public async Task<IReadOnlyList<(string Identity, string Name)>> ListGuestsAsync(long channelId, CancellationToken ct = default)
    {
        if (_client is null) return [];
        try
        {
            var res = await _client.ListParticipants(new ListParticipantsRequest { Room = LiveKitRooms.Name(space.Space.Id, channelId) });
            return res.Participants
                .Where(p => p.Identity.StartsWith("guest-", StringComparison.Ordinal))
                .Select(p => (p.Identity, p.Name))
                .ToList();
        }
        catch { return []; /* room may not exist — no guests */ }
    }
}

public sealed class LiveKitWebhookReceiver : ILiveKitWebhookReceiver
{
    private readonly string? _key;
    private readonly string? _secret;
    private readonly ILogger<LiveKitWebhookReceiver> _logger;

    public LiveKitWebhookReceiver(IOptions<VoiceOptions> options, ILogger<LiveKitWebhookReceiver> logger)
    {
        _logger = logger;
        var o = options.Value;
        if (!string.IsNullOrEmpty(o.LiveKitApiKey) && !string.IsNullOrEmpty(o.LiveKitApiSecret))
        {
            _key = o.LiveKitApiKey;
            _secret = o.LiveKitApiSecret;
        }
    }

    // Verification is done BY HAND, not via the SDK's WebhookReceiver: the SDK (1.2.2, latest)
    // parses the event with a strict protobuf JSON parser that throws "Unknown field" on payloads
    // from newer livekit-server builds (e.g. participant "capabilities"), rejecting every event
    // that carries a participant. The signature scheme itself is trivial and stable — an HS256
    // JWT whose "sha256" claim commits to the body — so we check that directly and then read the
    // event with a lenient JSON parser that ignores fields it doesn't know.
    public WebhookEventInfo? Verify(string body, string authHeader)
    {
        if (_key is null || _secret is null) return null;
        try
        {
            var token = authHeader.StartsWith("Bearer ") ? authHeader["Bearer ".Length..].Trim() : authHeader.Trim();
            var parts = token.Split('.');
            if (parts.Length != 3) throw new InvalidOperationException("malformed JWT");

            using var hmac = new System.Security.Cryptography.HMACSHA256(System.Text.Encoding.UTF8.GetBytes(_secret));
            var expected = hmac.ComputeHash(System.Text.Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]));
            if (!System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Base64Url(parts[2]), expected))
                throw new InvalidOperationException("invalid signature");

            using var claims = System.Text.Json.JsonDocument.Parse(Base64Url(parts[1]));
            var c = claims.RootElement;
            if (c.TryGetProperty("iss", out var iss) && iss.GetString() != _key)
                throw new InvalidOperationException("issuer mismatch");
            if (c.TryGetProperty("exp", out var exp)
                && DateTimeOffset.FromUnixTimeSeconds(exp.GetInt64()) < DateTimeOffset.UtcNow.AddMinutes(-5))
                throw new InvalidOperationException("token expired");

            // The sha256 claim is base64 in current servers; accept hex too for older builds.
            var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(body));
            var claimed = c.GetProperty("sha256").GetString() ?? "";
            if (!claimed.Equals(Convert.ToBase64String(hash), StringComparison.Ordinal)
                && !claimed.Equals(Convert.ToHexString(hash), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("body hash mismatch");

            using var evt = System.Text.Json.JsonDocument.Parse(body);
            var e = evt.RootElement;
            static string? Str(System.Text.Json.JsonElement el, string prop) =>
                el.ValueKind == System.Text.Json.JsonValueKind.Object
                && el.TryGetProperty(prop, out var v)
                && v.ValueKind == System.Text.Json.JsonValueKind.String ? v.GetString() : null;
            var participant = e.TryGetProperty("participant", out var p) ? p : default;
            var room = e.TryGetProperty("room", out var r) ? r : default;
            return new WebhookEventInfo(Str(e, "event") ?? "", Str(participant, "identity"), Str(participant, "name"), Str(room, "name"));
        }
        catch (Exception ex)
        {
            // The REASON matters: "invalid signature" is a key mismatch, "expired" is clock skew,
            // a parse error is a version gap — each has a different fix.
            _logger.LogWarning("livekit webhook verification failed: {Reason}", ex.Message);
            return null;
        }
    }

    private static byte[] Base64Url(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}
