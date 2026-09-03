/**
 * The personal-data consent text this build displays, by its issue date.
 *
 * DEFINED TWICE, ON PURPOSE, AND CHECKED NOWHERE — like the protocol frames and the backup
 * format. The other half is ServerDotnet/Shared/Outcome.Abstractions/Legal/PdnConsent.cs, and
 * the text itself is frontend/public/pdn.html. All three move in one commit or none.
 *
 * The client sends this with the registration, and the server records what it was sent rather
 * than stamping its own: an older build showing an older text should be recorded honestly as
 * that older text, not silently upgraded to whatever is published today.
 */
export const PDN_CONSENT_VERSION = "2026-08-21";

/** Where the text lives. Static HTML, so it opens even when the app itself is broken. */
export const PDN_CONSENT_URL = "/pdn.html#soglasie";

/** The policy — what the operator does with the data. Published under art. 18.1, and NOT part
 *  of the consent: since 156-ФЗ (1 Sep 2025) consent has to stand apart from other documents,
 *  so it is linked separately rather than folded into the same sentence. */
export const PDN_POLICY_URL = "/pdn.html";

/**
 * Whether OUR consent text is the right thing to show against `host`.
 *
 * The text names a specific operator — us. On a server somebody else runs, the operator is
 * them: asking there would not be an extra safeguard, it would put our name on their data
 * processing and collect a consent that means nothing. This client can sign into any instance,
 * so that is the common case rather than an edge one.
 *
 * Tenant spaces on *.outcome.ru are our infrastructure and count. An empty host means the
 * instance that served this page, which on our own deployment is us.
 *
 * Mirrors pdnConsentApplies() in mobile/lib/pdn_consent.dart — the two must agree, or the same
 * account sees the box on one client and not the other.
 */
export function pdnConsentApplies(host: string): boolean {
  const h = host.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]!
    .split(":")[0]!;
  if (h === "") return typeof window !== "undefined"
    && (window.location.hostname === "outcome.ru"
        || window.location.hostname.endsWith(".outcome.ru"));
  return h === "outcome.ru" || h.endsWith(".outcome.ru");
}
