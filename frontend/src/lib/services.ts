import { createApiClient } from "./api";
import { createWsClient, type ConnectionState } from "./ws";
import type { ClientMessage } from "./types";
import { clearAuth } from "@stores/auth.store";
import { setConnectionStatus } from "@stores/ui.store";

// Same-origin: host "" -> api/ws derive the origin from window.location (nginx
// reverse-proxies /api and /api/v1/ws to the backend).
export const api = createApiClient({ host: "" }, () => {
  // 401 -> session expired; the App effect tears down WS + session.
  clearAuth();
});

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
