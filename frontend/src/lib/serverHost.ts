/**
 * The Outcome instance this client talks to. Empty host = same-origin (the instance that
 * served the SPA — the default). A non-empty host is a FOREIGN instance the user picked on
 * the login screen ("Сменить сервер"), and every REST/WS/asset URL must be built against
 * its origin instead of the page's.
 *
 * A bare "host[:port]" is assumed https — self-hosted instances sit behind TLS, and the
 * page itself is usually https (mixed content would block http targets anyway). An explicit
 * scheme ("http://lan-box:8080") is honored for LAN/dev setups.
 */

const LAST_HOST_KEY = "outcome:lastHost";

let currentHost = "";

export function setServerHost(host: string): void {
  currentHost = host.trim();
}

export function getServerHost(): string {
  return currentHost;
}

/**
 * The page's own origin, or "" when the page has no origin that could serve an API.
 *
 * The packaged desktop shell loads the SPA over a custom protocol (app://). That is a proper
 * secure context — getUserMedia works — but it is not an instance: "same-origin" means nothing
 * there, and a request to app://api/v1/... goes nowhere. Reporting "" instead lets every caller
 * below fall through to the server the user actually chose.
 */
function pageOrigin(): string {
  return /^https?:$/.test(window.location.protocol) ? window.location.origin : "";
}

/** Origin (scheme://authority) for a host string; "" → the page's own origin. */
export function originForHost(host: string): string {
  const h = host.trim();
  if (h.includes("://")) return h.replace(/\/+$/, "");
  if (h && h !== window.location.host) return `https://${h}`;

  // Same-origin, or nothing specified yet. On the web that is the instance that served the
  // page. In the desktop shell there is no such instance, so use the last server signed into —
  // and if there is not one either, return "" so the failure is a visible "no server" rather
  // than a silent request to a protocol that cannot answer.
  const page = pageOrigin();
  if (page) return page;
  const last = readLastHost().trim();
  if (!last) return "";
  return last.includes("://") ? last.replace(/\/+$/, "") : `https://${last}`;
}

/** Origin of the ACTIVE instance. */
export function serverOrigin(): string {
  return originForHost(currentHost);
}

/**
 * Absolute URL for a server-relative asset path (avatars, attachments — the API hands out
 * paths like "/api/v1/files/<id>"). Absolute/data/blob URLs pass through untouched. On the
 * default same-origin deployment this returns the path against the page origin — identical
 * behavior to plain relative src.
 */
export function assetUrl(path: string): string;
export function assetUrl(path: string | null | undefined): string | undefined;
export function assetUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:)/i.test(path) || path.startsWith("//")) return path;
  return serverOrigin() + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * The same file, downscaled. Avatars are drawn at thirty pixels and thumbnails at a few
 * hundred, and both were being served whatever the camera produced — a 600 KB avatar, a 6 MB
 * thumbnail. The server keeps a preview beside every picture and hands it over for this;
 * anything without one falls back to the original, so the URL is always safe to use.
 */
export function assetUrlSmall(path: string | null | undefined): string | undefined {
  return sized(path, "sm");
}

/**
 * The same file at screen size — what the viewer opens. The thumbnail is far too coarse for
 * that and the original is a camera's full output: several megabytes to fill a window that
 * cannot show a tenth of them, which on an ordinary line is a wait of tens of seconds. This
 * is the copy worth waiting for; the original stays behind "open original" for whoever wants
 * it. Falls back to the original when no such copy exists.
 */
export function assetUrlMedium(path: string | null | undefined): string | undefined {
  return sized(path, "md");
}

function sized(path: string | null | undefined, sz: "sm" | "md"): string | undefined {
  const url = assetUrl(path);
  if (!url) return undefined;
  return url + (url.includes("?") ? "&" : "?") + "sz=" + sz;
}

/** The host last used to sign in — prefills the login screen's server field. */
export function readLastHost(): string {
  try { return localStorage.getItem(LAST_HOST_KEY) ?? ""; } catch { return ""; }
}

export function rememberLastHost(host: string): void {
  try {
    const h = host.trim();
    if (h) localStorage.setItem(LAST_HOST_KEY, h);
    else localStorage.removeItem(LAST_HOST_KEY);
  } catch { /* ignore */ }
}
