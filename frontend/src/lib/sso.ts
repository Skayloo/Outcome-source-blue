/**
 * SSO (Google / Yandex) on the web.
 *
 * The whole OAuth dance is server-side; the browser's only jobs are to walk the user to
 * /auth/oauth/<provider>/start and to pick the session token back out of the URL fragment
 * the callback lands on (`#sso=…`). A FRAGMENT, not a query: it never leaves the browser,
 * so the token stays out of proxy/server access logs and out of the Referer header.
 */
import { api } from "@lib/services";
import { wirePostAuth } from "@lib/session";
import { createLogger } from "@lib/logger";
import { originForHost } from "@lib/serverHost";

const log = createLogger("sso");

export type SsoProvider = "google" | "yandex";

/** Providers the server actually holds keys for. Empty list → no SSO buttons. */
export async function fetchSsoProviders(): Promise<SsoProvider[]> {
  try {
    const r = await api.ssoProviders();
    return r.providers.filter((p): p is SsoProvider => p === "google" || p === "yandex");
  } catch {
    return [];
  }
}

/** Leave the SPA for the provider's consent screen. We come back at `#sso=…`.
 *  With a custom host the whole flow runs on THAT instance — its registered redirect_uri
 *  points at its own origin, so the callback lands the user on its hosted web app. */
export function startSso(provider: SsoProvider, host = ""): void {
  window.location.assign(`${originForHost(host)}/api/v1/auth/oauth/${provider}/start?target=web`);
}

/**
 * Consume a token the SSO callback left in the fragment. Returns an error code when the
 * flow failed, null when there was nothing to consume or the sign-in succeeded.
 * Call BEFORE restoreSession(): a fresh SSO token must win over a stale stored one.
 */
export function consumeSsoRedirect(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#sso")) return null;

  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("sso");
  const error = params.get("sso_error");
  // Scrub the fragment either way, so a reload can't replay it and the token
  // isn't left sitting in the address bar / history.
  history.replaceState(null, "", window.location.pathname + window.location.search);

  if (error !== null) {
    log.warn("SSO failed", { error });
    return error;
  }
  if (token === null || token.length === 0) return null;

  // The username is cosmetic here — the WS auth_ok replaces it with the real profile.
  wirePostAuth("", token, "");
  return null;
}
