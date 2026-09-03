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
import { originForHost, readLastHost } from "@lib/serverHost";
import { desktop } from "@lib/desktop";

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

/**
 * The server this sign-in was started against.
 *
 * The browser does not need this: its callback lands on that server's own origin, so
 * "same-origin" is already the right answer. The desktop shell's callback arrives over
 * outcome://, carrying a token and nothing else — so the host has to be remembered here or
 * the session is wired up pointing at nowhere.
 */
let ssoStartedForHost = "";

/** Leave the SPA for the provider's consent screen. We come back at `#sso=…`.
 *  With a custom host the whole flow runs on THAT instance — its registered redirect_uri
 *  points at its own origin, so the callback lands the user on its hosted web app. */
export function startSso(provider: SsoProvider, host = ""): void {
  ssoStartedForHost = host;
  const shell = desktop();
  // `target=app` makes the callback come home as outcome://sso?token=… instead of landing on
  // the website. Without it the desktop client sends the user to the browser, the browser
  // finishes the sign-in, and the app window is still sitting on the login screen — which is
  // exactly what it did before this branch existed.
  const url = `${originForHost(host)}/api/v1/auth/oauth/${provider}/start?target=${shell ? "app" : "web"}`;

  if (shell) {
    // The system browser, not this window: /start sets an anti-CSRF nonce cookie that the
    // callback checks, and the provider's consent page has no business rendering inside a
    // shell that carries a preload bridge.
    void shell.openExternal(url);
    return;
  }
  window.location.assign(url);
}

/**
 * Receive the token the desktop shell caught on the outcome:// scheme. No-op in a browser,
 * where the fragment path in [consumeSsoRedirect] does the same job.
 *
 * Returns an unsubscribe function.
 */
export function wireDesktopSso(onError: (code: string) => void): () => void {
  const shell = desktop();
  if (!shell) return () => {};
  return shell.onSso(({ token, error }) => {
    if (error) {
      log.warn("SSO failed", { error });
      onError(error);
      return;
    }
    if (!token) return;
    // The host matters here in a way it does not on the web. wirePostAuth calls
    // rememberLastHost with whatever it is given, so passing "" does not merely fail to set
    // the server — it ERASES the stored one, and the next thing to ask "which instance?" gets
    // no answer. Username stays cosmetic, exactly as in the fragment path: the WS auth_ok
    // replaces it.
    wirePostAuth(ssoStartedForHost || readLastHost(), token, "");
  });
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
