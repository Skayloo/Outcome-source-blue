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

/** Origin (scheme://authority) for a host string; "" → the page's own origin. */
export function originForHost(host: string): string {
  const h = host.trim();
  if (!h || h === window.location.host) return window.location.origin;
  if (h.includes("://")) return h.replace(/\/+$/, "");
  return `https://${h}`;
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
  const url = assetUrl(path);
  if (!url) return undefined;
  return url + (url.includes("?") ? "&" : "?") + "sz=sm";
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
