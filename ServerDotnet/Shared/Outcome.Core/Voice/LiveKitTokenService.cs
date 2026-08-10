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
                // like this exists to pull outsiders INTO a real conversation. The data
                // channel stays shut: it carries app-level messages, and an anonymous
                // visitor has no business speaking that protocol.
                CanPublishData = false,
                CanPublishSources = { "microphone", "camera", "screen_share", "screen_share_audio" },
            })
            // Short leash: the link page re-requests a token on every join anyway.
            .WithTtl(TimeSpan.FromHours(6));
        return token.ToJwt();
    }
}
