/**
 * Servers store — holds the list of servers (guilds) the current user belongs
 * to and which one is active. The active server id scopes every REST request
 * (via the X-Server-Id header) and the WS auth frame (via server_id).
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type { ServerDto } from "@lib/types";

const ACTIVE_SERVER_KEY = "outcome:activeServer";
const DEFAULT_SERVER_ID = 1;

/** Read the persisted active server id from localStorage (default 1). */
function loadActiveServerId(): number {
  try {
    const raw = localStorage.getItem(ACTIVE_SERVER_KEY);
    if (raw !== null) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* localStorage may be unavailable */
  }
  return DEFAULT_SERVER_ID;
}

export interface ServersState {
  readonly servers: readonly ServerDto[];
  readonly activeServerId: number;
}

/**
 * Seed the rail with the primary server so it is never empty before
 * GET /servers resolves (or if it fails). Replaced by setServers() on boot.
 */
const PRIMARY_SERVER: ServerDto = {
  id: DEFAULT_SERVER_ID,
  name: "Outcome",
  owner_id: 0,
  icon: null,
};

const INITIAL_STATE: ServersState = {
  servers: [PRIMARY_SERVER],
  activeServerId: loadActiveServerId(),
};

export const serversStore = createStore<ServersState>(INITIAL_STATE);

/** Replace the full server list. */
export function setServers(list: readonly ServerDto[]): void {
  serversStore.setState((prev) => ({ ...prev, servers: list }));
}

/** Set the active server id and persist it to localStorage. */
export function setActiveServer(id: number): void {
  try {
    localStorage.setItem(ACTIVE_SERVER_KEY, String(id));
  } catch {
    /* localStorage may be unavailable */
  }
  serversStore.setState((prev) => ({ ...prev, activeServerId: id }));
}

/**
 * Synchronous getter for the active server id. Readable without React so the
 * api/ws clients can scope requests. Falls back to localStorage (then the
 * default) if the store has not been initialized yet.
 */
export function getActiveServerId(): number {
  const id = serversStore.select((s) => s.activeServerId);
  if (Number.isFinite(id) && id > 0) return id;
  return loadActiveServerId();
}
