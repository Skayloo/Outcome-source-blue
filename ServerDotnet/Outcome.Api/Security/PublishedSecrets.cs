using System.Security.Cryptography;
using System.Text;

namespace Outcome.Api.Security;

/// <summary>
/// The LiveKit API secret signs every media token — whoever has it can mint a seat in any room.
/// Same refusal as the JWT key (RejectAKeyEverybodyHas): a placeholder from .env.example, or the
/// pair voice/livekit2.yaml carried in the published repositories until 1.31.60, stops the boot.
/// The published secret is held as a hash so it is not repeated in the source once more.
/// </summary>
public static class PublishedSecrets
{
    private static readonly string[] PublishedLiveKitSecretSha256 =
    [
        "d1b9a489b50e2064da2804dac53ab58027c211ad70e4660cd7864452eac923e0", // voice/livekit2.yaml
    ];

    public static void RejectLiveKitSecret(string? secret)
    {
        if (string.IsNullOrEmpty(secret)) return; // voice not configured
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(secret)));
        if (secret.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase) || PublishedLiveKitSecretSha256.Contains(hash))
            throw new InvalidOperationException(
                "Voice:LiveKitApiSecret is an example or published value. Generate one (openssl rand -hex 32) and set it in LIVEKIT_KEYS and OUTCOME_Voice__LiveKitApiSecret.");
    }
}
