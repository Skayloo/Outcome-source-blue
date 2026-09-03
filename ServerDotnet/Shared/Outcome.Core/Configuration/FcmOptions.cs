namespace Outcome.Infrastructure.Configuration;

/// <summary>
/// Firebase Cloud Messaging credentials, bound from the <c>Fcm</c> section (or
/// <c>OUTCOME_Fcm__Credentials</c>). Leave both empty to turn the transport off.
///
/// This is a Google **service account** key — Firebase Console → Project settings → Service
/// accounts → Generate new private key. It is not the same thing as the
/// <c>google-services.json</c> that ships inside the Android app: that one identifies the app to
/// Google, this one authorises sending to it, and putting the second where the first goes hands
/// anyone who unzips the APK the ability to push to every install.
///
/// RuStore does not cover this. Its console configures only its own transport — there is no
/// field there for a Firebase key — so reaching a phone that has Google services but no RuStore
/// means talking to FCM ourselves.
/// </summary>
public sealed class FcmOptions
{
    /// <summary>Path to the service-account JSON. Ignored when <see cref="Credentials"/> is set.</summary>
    public string CredentialsPath { get; set; } = "";

    /// <summary>The service-account JSON itself, for deployments that inject secrets as env vars.</summary>
    public string Credentials { get; set; } = "";
}
