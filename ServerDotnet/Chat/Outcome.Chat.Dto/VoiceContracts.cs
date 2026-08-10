namespace Outcome.Application.Voice;

public enum VoiceFlag { Muted, Deafened, Speaking, Camera, Screenshare }

/// <summary>Live voice state for a user, with username for the wire payload.</summary>
public sealed record VoiceStateDto(
    long ChannelId, long UserId, string Username,
    bool Muted, bool Deafened, bool Speaking, bool Camera, bool Screenshare);

public sealed record JoinVoiceResult(
    string Token, string Url, string Quality, int Bitrate, int MaxUsers,
    VoiceStateDto JoinerState, IReadOnlyList<VoiceStateDto> ExistingStates, long? PreviousChannelId);

public sealed record VoiceTokenResult(long ChannelId, string Token, string Url);

public static class VoiceQuality
{
    public static bool IsValid(string q) => q is "low" or "medium" or "high" or "source";

    public static int Bitrate(string quality) => quality switch
    {
        "low" => 600_000,
        "high" => 4_000_000,
        "source" => 8_000_000,
        _ => 1_700_000, // medium
    };
}
