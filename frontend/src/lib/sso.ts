/**
 * SSO (Google / Yandex) on the web.
 *
 * The whole OAuth dance is server-side; the browser's only jobs are to walk the user to
 * /auth/oauth/<provider>/start and to pick the session token back out of the URL fragment
 * the callback lands on (`#sso=…`). A FRAGMENT, not a query: it never leaves the browser,
 * so the token stays out of proxy/server access logs and out of the Referer header.
 */
import { api } from "@lib/services";
import { storedSessionHere, wirePostAuth } from "@lib/session";
import { getToken } from "@stores/auth.store";
import { createLogger } from "@lib/logger";
import { originForHost, readLastHost } from "@lib/serverHost";
import { desktop } from "@lib/desktop";
import { t } from "@lib/i18n";
import { confirm } from "@components/ConfirmDialog";

const log = createLogger("sso");

/**
 * "A sign-in was started HERE, a moment ago." A token that turns up without one is someone
 * else's: anyone could send a link ending in `#sso=<their token>` (or open `outcome://sso?token=…`
 * on a desktop), and the page signed the visitor into THAT account — whatever they then wrote or
 * uploaded went to a stranger. Single use, ten minutes. Kept in sessionStorage on the web (the
 * provider round-trip reloads the tab) and in memory in the shell (its window never navigates).
 */
const PENDING_KEY = "outcome:sso-pending";
const PENDING_MS = 10 * 60 * 1000;
let shellPendingAt = 0;

function markPending(): void {
  shellPendingAt = Date.now();
  try { sessionStorage.setItem(PENDING_KEY, String(shellPendingAt)); } catch { /* private mode */ }
}

function takePending(): boolean {
  let at = shellPendingAt;
  shellPendingAt = 0;
  try {
    at = Math.max(at, Number(sessionStorage.getItem(PENDING_KEY) ?? 0));
    sessionStorage.removeItem(PENDING_KEY);
  } catch { /* private mode */ }
  return at > 0 && Date.now() - at < PENDING_MS;
}

/** A sign-in finished some other way (password, code, reset): the SSO attempt that may have been
 *  started and abandoned before it is over, and its marker must not wave a later token through. */
export function forgetPendingSso(): void {
  takePending();
}

/** No sign-in was started here (or it was started on another server's page, whose storage
 *  this one cannot see): say whose account it is and let the person decide. */
async function confirmUnasked(token: string, finish: () => void): Promise<void> {
  let name = "";
  try {
    const r = await fetch("/api/v1/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) name = String(((await r.json()) as { username?: unknown }).username ?? "");
  } catch { /* shown without a name */ }
  if (!name) { log.warn("SSO token with no pending sign-in, and no account behind it — ignored"); return; }
  const ok = await confirm({
    title: t("auth.ssoConfirmTitle"),
    message: t("auth.ssoConfirmBody", { name }),
    highlight: name,
    confirmLabel: t("auth.ssoConfirmYes"),
  });
  if (ok) finish();
}

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
  markPending();
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
      // The attempt is over: its marker would otherwise wave the NEXT token through for ten minutes.
      takePending();
      log.warn("SSO failed", { error });
      onError(error);
      return;
    }
    if (!token) return;
    // Someone is signed in already. This listener lives as long as the window, and a token arriving
    // now replaced the session without a word — the person kept working in another account.
    if (getToken() !== null) {
      takePending();
      log.warn("SSO token while signed in — ignored");
      return;
    }
    // Only the answer to a sign-in started in this window. The shell has no page to ask
    // /auth/me on for an unknown server, so an unasked token is dropped.
    if (!takePending()) {
      log.warn("SSO token with no pending sign-in — ignored");
      return;
    }
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
    takePending(); // this attempt is over (see wireDesktopSso)
    log.warn("SSO failed", { error });
    return error;
  }
  if (token === null || token.length === 0) return null;

  // The username is cosmetic here — the WS auth_ok replaces it with the real profile. Silently only
  // for the answer to a sign-in started here while nobody was signed in; replacing a live session
  // is always asked, naming the account.
  if (takePending() && storedSessionHere() === null) wirePostAuth("", token, "");
  else void confirmUnasked(token, () => wirePostAuth("", token, ""));
  return null;
}
