namespace Outcome.Infrastructure.Configuration;

/// <summary>
/// Apple Push Notification service credentials, bound from the <c>Apns</c> section (or
/// <c>OUTCOME_Apns__KeyId</c> etc.). Leave the key empty to disable push — nothing else
/// changes, messages simply arrive only over the live socket.
///
/// The signing key is a token key (<c>AuthKey_XXXXXXXXXX.p8</c>) from the Apple developer
/// portal. It signs for the whole team, so it never belongs in the repository: give it as a
/// path to a file mounted at deploy time, or paste the PEM into <see cref="Key"/> via an
/// environment variable.
/// </summary>
public sealed class ApnsOptions
{
    /// <summary>Path to the .p8 file. Ignored when <see cref="Key"/> is set.</summary>
    public string KeyPath { get; set; } = "";
    /// <summary>The .p8 contents (PKCS#8 PEM), for deployments that inject secrets as env vars.</summary>
    public string Key { get; set; } = "";
    /// <summary>The 10-character Key ID shown next to the key in the portal.</summary>
    public string KeyId { get; set; } = "";
    public string TeamId { get; set; } = "";
    /// <summary>The app's bundle id — APNs calls this the topic.</summary>
    public string BundleId { get; set; } = "com.outcome.outcome";
}
