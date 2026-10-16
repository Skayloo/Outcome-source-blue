import { createApiClient } from "./api";
import { createWsClient, type ConnectionState } from "./ws";
import type { ClientMessage } from "./types";
import { clearAuth } from "@stores/auth.store";
import { setConnectionStatus } from "@stores/ui.store";

// Same-origin: host "" -> api/ws derive the origin from window.location (nginx
// reverse-proxies /api and /api/v1/ws to the backend).
// What a 401 or an auth_error does. session.ts installs the full teardown (it imports this file,
// so it cannot be imported back); until it loads, clearing auth is all there is to do.
let onSessionLost: () => void = clearAuth;
export function setSessionLostHandler(fn: () => void): void { onSessionLost = fn; }
/** The server no longer accepts this session — revoked elsewhere or expired. */
export function sessionLost(): void { onSessionLost(); }

export const api = createApiClient({ host: "" }, () => sessionLost());

export const ws = createWsClient();

/** Send a WS frame by type+payload without fighting the ClientMessage union. */
export function wsSend(type: string, payload: unknown): void {
  ws.send({ type, payload } as ClientMessage);
}

ws.onStateChange((state: ConnectionState) => {
  setConnectionStatus(
    state === "connected" ? "connected"
      : state === "disconnected" ? "disconnected"
      : "reconnecting",
  );
});
