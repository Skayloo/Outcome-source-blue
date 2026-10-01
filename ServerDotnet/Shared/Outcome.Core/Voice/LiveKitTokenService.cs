using Livekit.Server.Sdk.Dotnet;
using Microsoft.Extensions.Options;
using Outcome.Shared.Abstractions.Voice;
using Outcome.Infrastructure.Tenancy;
using Outcome.Infrastructure.Configuration;

namespace Outcome.Infrastructure.Voice;

/// <summary>LiveKit access-token minting via livekit-server-sdk-dotnet.</summary>
public sealed class LiveKitTokenService(IOptions<VoiceOptions> options, ICurrentSpace space) : ILiveKitTokenService
{
    private readonly VoiceOptions _opt = options.Value;

    /// <summary>A guest token's lifetime. Also how ReadGuestToken finds the moment it was issued
    /// (expiry minus this) — exact, whatever the SDK writes or backdates in iat/nbf.</summary>
    private static readonly TimeSpan GuestTokenTtl = TimeSpan.FromHours(6);

    public bool IsConfigured => !string.IsNullOrEmpty(_opt.LiveKitApiKey) && !string.IsNullOrEmpty(_opt.LiveKitApiSecret);

    public string Url => _opt.LiveKitUrl;

    public string GenerateToken(long userId, string username, long channelId, bool canPublish, bool canSubscribe, string sessionId)
    {
        var token = new AccessToken(_opt.LiveKitApiKey, _opt.LiveKitApiSecret);
        token.WithIdentity(ILiveKitTokenService.IdentityFor(userId, sessionId))
            .WithName(username)
            .WithGrants(new VideoGrants
            {
                RoomJoin = true,
                Room = LiveKitRooms.Name(space.Space.Id, channelId),
                CanPublish = canPublish,
                CanSubscribe = canSubscribe,
                CanPublishData = canPublish,
                // Raising a hand is an attribute on the participant, not a message: attributes
                // survive somebody joining late, and clear themselves when the person leaves.
                CanUpdateOwnMetadata = true,
            })
            .WithTtl(TimeSpan.FromHours(24));
        return token.ToJwt();
    }

    public string GenerateGuestToken(string displayName, long channelId)
    {
        var nonce = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8));
        var token = new AccessToken(_opt.LiveKitApiKey, _opt.LiveKitApiSecret);
        token.WithIdentity($"guest-{nonce}")
            .WithName(displayName)
            .WithGrants(new VideoGrants
            {
                RoomJoin = true,
                Room = LiveKitRooms.Name(space.Space.Id, channelId),
                CanPublish = true,
                CanSubscribe = true,
                // Guests get the full media kit — mic, camera, screen share — because a link
                // like this exists to pull outsiders INTO a real conversation.
                //
                // The data channel is open to them too, and that is a deliberate reversal: it
                // used to be shut on the grounds that an anonymous visitor has no business
                // speaking our protocol. But the only thing that travels on it is a reaction
                // and a raised hand, the meetings that need them are held on guest links, and
                // a feature half the room cannot use is not a feature. What makes it safe is
                // not the grant, it is the receiver: every message is parsed as untrusted,
                // the emoji must be one of a fixed handful, and anything faster than one every
                // 700 ms is dropped on the floor. See lib/voiceReactions.ts.
                CanPublishData = true,
                CanUpdateOwnMetadata = true,
                CanPublishSources = { "microphone", "camera", "screen_share", "screen_share_audio" },
            })
            // Short leash: the link page re-requests a token on every join anyway.
            .WithTtl(GuestTokenTtl);
        return token.ToJwt();
    }

    // The same HS256 check the webhook receiver does by hand, on a token we minted ourselves.
    public GuestTokenInfo? ReadGuestToken(string jwt)
    {
        if (!IsConfigured || string.IsNullOrEmpty(jwt)) return null;
        try
        {
            var parts = jwt.Split('.');
            if (parts.Length != 3) return null;
            using var hmac = new System.Security.Cryptography.HMACSHA256(System.Text.Encoding.UTF8.GetBytes(_opt.LiveKitApiSecret));
            var expected = hmac.ComputeHash(System.Text.Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]));
            if (!System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Base64Url(parts[2]), expected)) return null;

            using var doc = System.Text.Json.JsonDocument.Parse(Base64Url(parts[1]));
            var c = doc.RootElement;
            if (!c.TryGetProperty("iss", out var iss) || iss.GetString() != _opt.LiveKitApiKey) return null;
            if (!c.TryGetProperty("exp", out var exp) || DateTimeOffset.FromUnixTimeSeconds(exp.GetInt64()) < DateTimeOffset.UtcNow) return null;
            var identity = c.TryGetProperty("sub", out var sub) ? sub.GetString() ?? "" : "";
            if (!identity.StartsWith("guest-", StringComparison.Ordinal)) return null;
            var name = c.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            var room = c.TryGetProperty("video", out var v) && v.TryGetProperty("room", out var r) ? r.GetString() ?? "" : "";
            if (room.Length == 0) return null;
            var issued = DateTimeOffset.FromUnixTimeSeconds(exp.GetInt64()) - GuestTokenTtl;
            return new GuestTokenInfo(identity, name, room, issued.UtcDateTime);
        }
        catch
        {
            return null;
        }
    }

    private static byte[] Base64Url(string s)
    {
        var b = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(b.PadRight(b.Length + (4 - b.Length % 4) % 4, '='));
    }
}
