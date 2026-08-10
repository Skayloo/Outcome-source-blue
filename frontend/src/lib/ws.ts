// WebSocket Client — native browser WebSocket against the same-origin server.

import type { ServerMessage, ClientMessage } from "./types";
import { createLogger } from "./logger";
import { randomUUID } from "./uuid";
import { runtimeWsUrl } from "./runtimeConfig";
import { getActiveServerId } from "@stores/servers.store";

const log = createLogger("ws");

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

export type WsListener<T extends ServerMessage["type"]> = (
  payload: Extract<ServerMessage, { type: T }>["payload"],
  id?: string,
) => void;

/**
 * Certificate-mismatch event. Retained for API compatibility with callers;
 * never fires in a same-origin web build (the browser handles TLS).
 */
export interface CertTofuEvent {
  readonly host: string;
  readonly fingerprint: string;
  readonly status: "trusted_first_use" | "trusted" | "mismatch";
  readonly message?: string;
  readonly storedFingerprint?: string;
}

/** Parse the stored fingerprint from a cert-tofu message string. */
export function parseStoredFingerprint(message?: string): string | undefined {
  if (!message) return undefined;
  const match = /Stored:\s+(\S+)/.exec(message);
  return match?.[1];
}

export type CertMismatchListener = (event: CertTofuEvent) => void;

export interface WsClientConfig {
  readonly host: string;
  readonly token: string;
  readonly maxReconnectDelayMs?: number;
  readonly maxMessageSizeBytes?: number;
}

const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const DEFAULT_MAX_MESSAGE_SIZE = 1_048_576; // 1MB
const HEARTBEAT_INTERVAL_MS = 30_000;

function uuid(): string {
  return randomUUID();
}

/** Build the WebSocket URL: a runtime override (subdomain ingress) wins, else same-origin.
 *  A custom host (foreign instance from the login screen) is assumed wss, mirroring the
 *  https default in the REST client; an explicit http(s) scheme maps to ws(s). */
function wsUrlFor(host: string): string {
  const rt = runtimeWsUrl();
  if (rt) return rt;
  if (!host || host === window.location.host) {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}/api/v1/ws`;
  }
  if (host.includes("://")) {
    return `${host.replace(/^http/, "ws").replace(/\/+$/, "")}/api/v1/ws`;
  }
  return `wss://${host}/api/v1/ws`;
}

export function createWsClient() {
  let config: WsClientConfig | null = null;
  let state: ConnectionState = "disconnected";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let intentionalClose = false;
  let socketOpen = false;
  let lastSeq = 0;
  let browserWs: WebSocket | null = null;

  // Deduplication cache for reconnection replay. Armed at socket-open when reconnecting,
  // active THROUGH the post-auth_ok replay burst, released by the server's replay_done
  // frame (or the fallback timer for servers that don't send one).
  let replayDedup: Set<string> | null = null;
  let replayDoneTimer: ReturnType<typeof setTimeout> | null = null;
  const MAX_DEDUP_SIZE = 1000;

  function endReplayMode(): void {
    if (replayDoneTimer !== null) { clearTimeout(replayDoneTimer); replayDoneTimer = null; }
    replayDedup = null;
  }

  // Type-safe listener registry.
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();
  // State change listeners.
  const stateListeners = new Set<(state: ConnectionState) => void>();
  // Cert mismatch listeners (compatibility — never fired in web build).
  const certMismatchListeners = new Set<CertMismatchListener>();

  function setState(newState: ConnectionState): void {
    if (state !== newState) {
      state = newState;
      for (const listener of stateListeners) {
        try {
          listener(state);
        } catch (err) {
          log.error("State listener error", err);
        }
      }
    }
  }

  function getReconnectDelay(): number {
    const maxDelay = config?.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY;
    return Math.min(1000 * Math.pow(2, reconnectAttempt), maxDelay);
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socketOpen) {
        try {
          sendRaw(JSON.stringify({ type: "ping", payload: {} }));
        } catch {
          // Connection may have dropped.
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (intentionalClose || !config) return;
    const delay = getReconnectDelay();
    log.info("WebSocket reconnecting", {
      delayMs: delay,
      attempt: reconnectAttempt + 1,
      host: config?.host ?? "unknown",
      lastSeq,
    });
    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectAttempt++;
      connect(config!);
    }, delay);
  }

  function cancelReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function handleMessage(raw: string): void {
    const maxSize = config?.maxMessageSizeBytes ?? DEFAULT_MAX_MESSAGE_SIZE;

    if (raw.length > maxSize) {
      log.warn("Message exceeds size limit, dropping", { size: raw.length });
      return;
    }

    let parsed: { type?: string; payload?: unknown; id?: string; seq?: number };
    try {
      parsed = JSON.parse(raw) as { type?: string; payload?: unknown; id?: string; seq?: number };
    } catch {
      log.warn("Failed to parse WS message", { data: raw });
      return;
    }

    // Track the highest sequence number for reconnection replay.
    const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
    if (seq > lastSeq) {
      lastSeq = seq;
    }

    // Server pong messages have no payload — silently ignore.
    if (parsed.type === "pong") return;

    if (!parsed.type || parsed.payload === undefined) {
      log.warn("Invalid WS message: missing type or payload", { parsed });
      return;
    }

    const msg = parsed as unknown as ServerMessage;

    log.debug("WS ←", { type: msg.type, id: msg.id });

    // Deduplication during reconnection replay.
    if (replayDedup !== null && msg.type !== "auth_ok" && msg.type !== "auth_error" && msg.type !== "ready") {
      const dedupKey = msg.id ?? `${msg.type}:${seq}`;
      if (replayDedup.has(dedupKey)) {
        log.debug("Dedup: skipping duplicate message", { type: msg.type, key: dedupKey });
        return;
      }
      replayDedup.add(dedupKey);
      if (replayDedup.size > MAX_DEDUP_SIZE) {
        const first = replayDedup.values().next().value;
        if (first !== undefined) replayDedup.delete(first);
      }
    }

    // auth_error — non-recoverable.
    if (msg.type === "auth_error") {
      log.error("Authentication failed", { message: msg.payload.message });
      intentionalClose = true;
      dispatch(msg);
      void disconnectSocket();
      setState("disconnected");
      return;
    }

    // replay_done — the server finished the reconnect replay burst; leave dedup mode.
    if (msg.type === "replay_done") {
      endReplayMode();
      return;
    }

    // auth_ok — mark as connected. Replay dedup must stay ACTIVE here: the server sends the
    // replay burst AFTER auth_ok/ready, ending with replay_done. A fallback timer covers
    // servers that never send replay_done.
    if (msg.type === "auth_ok") {
      if (reconnectAttempt > 0) {
        log.info("WebSocket reconnected successfully", {
          afterAttempts: reconnectAttempt,
          host: config?.host ?? "unknown",
          lastSeq,
        });
      }
      if (replayDedup !== null) {
        if (replayDoneTimer !== null) clearTimeout(replayDoneTimer);
        replayDoneTimer = setTimeout(endReplayMode, 3000);
      }
      setState("connected");
      reconnectAttempt = 0;
      startHeartbeat();
    }

    dispatch(msg);
  }

  function dispatch(msg: ServerMessage): void {
    const typeListeners = listeners.get(msg.type);
    if (!typeListeners || typeListeners.size === 0) {
      log.debug("WS dispatch: no listeners", { type: msg.type });
      return;
    }
    for (const listener of typeListeners) {
      try {
        (listener)(msg.payload, msg.id);
      } catch (err) {
        log.error(`Listener error for ${msg.type}`, err);
      }
    }
  }

  function connect(cfg: WsClientConfig): void {
    config = cfg;
    intentionalClose = false;
    cancelReconnect();
    setState("connecting");

    const url = wsUrlFor(cfg.host);
    log.info("WebSocket connecting", { url, isReconnect: reconnectAttempt > 0, attempt: reconnectAttempt });

    if (browserWs) {
      browserWs.close();
    }

    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      log.error("Failed to construct WebSocket", err);
      scheduleReconnect();
      return;
    }
    browserWs = sock;

    // Every handler checks it still belongs to the CURRENT socket. Without this, closing
    // an old socket during reconnect() fired its onclose asynchronously, which nulled
    // browserWs (orphaning the NEW socket) and scheduled a second reconnect → two live
    // authenticated sockets and every broadcast dispatched twice.
    sock.onopen = () => {
      if (browserWs !== sock) return;
      socketOpen = true;
      log.info("WebSocket open, sending auth", {
        host: config?.host ?? "unknown",
        isReconnect: reconnectAttempt > 0,
        lastSeq,
      });
      if (reconnectAttempt > 0 && lastSeq > 0) {
        replayDedup = new Set();
      }
      setState("authenticating");
      if (config === null) return;
      send({
        type: "auth",
        payload: { token: config.token, last_seq: lastSeq, server_id: getActiveServerId() },
      });
    };

    sock.onclose = () => {
      if (browserWs !== sock) return; // stale socket from a previous connect()
      socketOpen = false;
      log.info("WebSocket closed", { host: config?.host ?? "unknown", intentional: intentionalClose });
      stopHeartbeat();
      browserWs = null;
      if (!intentionalClose) {
        scheduleReconnect();
      } else {
        setState("disconnected");
      }
    };

    sock.onerror = (err) => {
      if (browserWs !== sock) return;
      log.warn("WebSocket error", { error: err });
    };

    sock.onmessage = (e) => {
      if (browserWs !== sock) return;
      if (typeof e.data === "string") {
        handleMessage(e.data);
      }
    };
  }

  function sendRaw(json: string): void {
    if (browserWs && browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(json);
    } else {
      log.warn("Cannot send, WebSocket not open");
    }
  }

  function send(msg: ClientMessage | { type: string; payload: unknown }): string {
    const id = uuid();
    const envelope = { ...msg, id };
    log.debug("WS →", { type: msg.type, id });
    sendRaw(JSON.stringify(envelope));
    return id;
  }

  async function disconnectSocket(): Promise<void> {
    if (browserWs) {
      browserWs.close();
      browserWs = null;
    }
    socketOpen = false;
  }

  function disconnect(): void {
    intentionalClose = true;
    log.info("WebSocket disconnecting (intentional)", { host: config?.host ?? "unknown" });
    cancelReconnect();
    stopHeartbeat();
    void disconnectSocket();
    setState("disconnected");
    lastSeq = 0;
  }

  return {
    connect(cfg: WsClientConfig): void {
      connect(cfg);
    },

    /**
     * Reconnect using the current config so a fresh, server-scoped READY
     * arrives (used when switching the active server). Resets the sequence
     * cursor so the new connection is treated as a clean session, not a replay.
     */
    reconnect(): void {
      if (!config) return;
      const cfg = config;
      cancelReconnect();
      stopHeartbeat();
      reconnectAttempt = 0;
      lastSeq = 0;
      endReplayMode();
      void disconnectSocket();
      connect(cfg);
    },

    disconnect,

    send(msg: ClientMessage): string {
      return send(msg);
    },

    on<T extends ServerMessage["type"]>(
      type: T,
      listener: WsListener<T>,
    ): () => void {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      const set = listeners.get(type)!;
      set.add(listener as unknown as WsListener<ServerMessage["type"]>);
      return () => {
        set.delete(listener as unknown as WsListener<ServerMessage["type"]>);
      };
    },

    onStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    /** Compatibility no-op: cert mismatches can't occur in a browser build. */
    onCertMismatch(listener: CertMismatchListener): () => void {
      certMismatchListeners.add(listener);
      return () => certMismatchListeners.delete(listener);
    },

    /** Compatibility no-op for the web build. */
    async acceptCertFingerprint(_host: string, _fingerprint: string): Promise<void> {
      // No-op: the browser manages TLS trust.
    },

    getState(): ConnectionState {
      return state;
    },

    isReplaying(): boolean {
      return replayDedup !== null;
    },

    /** @internal for testing */
    _getWs(): WebSocket | null {
      return browserWs;
    },
  };
}

export type WsClient = ReturnType<typeof createWsClient>;
