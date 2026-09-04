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
            .WithTtl(TimeSpan.FromHours(6));
        return token.ToJwt();
    }
}
