namespace Outcome.Infrastructure.Configuration;

/// <summary>
/// RuStore push credentials, bound from the <c>RuStorePush</c> section (or
/// <c>OUTCOME_RuStorePush__ProjectId</c> etc.). Leave <see cref="ServiceToken"/> empty to turn
/// the transport off — nothing else changes, Android devices registered against it simply stop
/// being reachable while the app is closed.
///
/// Both values come from RuStore Console → the app → Push notifications → Projects. They are
/// not equally secret: the PROJECT ID ships inside every copy of the Android app, because the
/// client SDK reads it from the manifest and has no other way to be told. The SERVICE TOKEN is
/// what authorises sending, and it must never leave the server.
/// </summary>
public sealed class RuStorePushOptions
{
    public string ProjectId { get; set; } = "";
    public string ServiceToken { get; set; } = "";

    /// <summary>The gateway. Overridable only so a test can point it at something local.</summary>
    public string BaseUrl { get; set; } = "https://vkpns.rustore.ru";
}
