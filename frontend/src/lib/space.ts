/**
 * The space this page is served from — the only one there is. Its name and logo are what
 * the sign-in page shows; the admin console asks whether it is the instance's own (it is).
 *
 * Cached for the session.
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
    .then((s) => { cached = s; return s; })
    .catch(() => null)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Synchronous read; null until the first load resolves. */
export function spaceInfo(): SpaceInfo | null {
  return cached;
}

/** False until the lookup answers, so operator-only sections never flash before it. */
export function isRootSpace(): boolean {
  return cached?.is_root === true;
}
