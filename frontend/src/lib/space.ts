/**
 * Which SPACE this page is served from. A tenant's subdomain is a different instance of the
 * product: its own users, its own data — and a smaller admin console, because logs, health,
 * instance settings and the space registry belong to whoever runs the instance.
 *
 * Cached for the session: the answer is a property of the host, and the host cannot change
 * without a page load.
 */
import { api } from "./services";

export interface SpaceInfo {
  readonly space_id: number;
  readonly slug: string;
  readonly name: string;
  readonly icon: string | null;
  readonly is_root: boolean;
}

let cached: SpaceInfo | null = null;
let inFlight: Promise<SpaceInfo | null> | null = null;

export function loadSpace(): Promise<SpaceInfo | null> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= api.getSpaceByHost()
    .then((s) => { cached = s; hideTenantFromSearch(s); return s; })
    .catch(() => null)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * A company's space should not turn up in search results — its sign-in page is nobody's
 * business but its own. robots.txt cannot express this: one file is served for every host,
 * and only the server knows which hosts are tenants.
 *
 * Written from JavaScript, which both Google and Yandex execute when indexing. A response
 * header would be stronger, but nginx has no idea which space it is serving, and teaching it
 * would mean a second source of truth for the same question.
 */
function hideTenantFromSearch(space: SpaceInfo | null): void {
  if (!space || space.is_root) return;
  if (document.querySelector('meta[name="robots"]')) return;
  const tag = document.createElement("meta");
  tag.name = "robots";
  tag.content = "noindex, nofollow";
  document.head.appendChild(tag);
}

/** Synchronous read; null until the first load resolves. */
export function spaceInfo(): SpaceInfo | null {
  return cached;
}

/** Conservative default: assume a tenant until proven otherwise, so operator-only sections
 *  never flash on a customer's subdomain. */
export function isRootSpace(): boolean {
  return cached?.is_root === true;
}
