namespace Outcome.Shared.Legal;

/// <summary>
/// The personal-data consent text currently published, identified by the date it was issued.
///
/// Russian law (152-ФЗ) makes an operator of anyone processing personal data — an email address
/// alone is enough — and the operator has to be able to show that consent was obtained. A
/// checkbox that leaves no trace shows nothing, so every account records the moment and the
/// version; see <c>User.ConsentAt</c> / <c>ConsentVersion</c>.
///
/// WHEN THE TEXT CHANGES, change this string in the same commit as the document. They are a
/// pair that has to move together: a version naming a text nobody can produce is worse than no
/// version at all, and a reworded text under an unchanged version silently rewrites what past
/// users are recorded as having agreed to.
/// </summary>
public static class PdnConsent
{
    /// <summary>Issue date of the published text, ISO-8601. Recorded against every new account.</summary>
    public const string Version = "2026-08-21";

    /// <summary>Where the text lives, for clients that need to link to it.</summary>
    public const string Path = "/pdn.html";
}
