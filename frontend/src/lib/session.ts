import { resetAccountStores } from "@lib/store";
import { api, ws } from "./services";
import { wireDispatcher, loadDmChannels } from "./dispatcher";
import { createLogger } from "./logger";
import { authStore, clearAuth } from "@stores/auth.store";
import {
  serversStore,
  setServers,
  setActiveServer,
  getActiveServerId,
} from "@stores/servers.store";
import { channelsStore, setActiveChannel, setPendingChannel } from "@stores/channels.store";
import { invalidateLoadedChannels } from "@stores/messages.store";
import { dmStore, clearDmUnread } from "@stores/dm.store";
import { setFriendsList } from "@stores/friends.store";
import { uiStore, setSidebarMode } from "@stores/ui.store";
import { armNotificationPermissionPrompt } from "@lib/notifications";
import { setServerHost, rememberLastHost } from "@lib/serverHost";

// The signed-in session lives in localStorage, NOT sessionStorage: the latter is wiped the
// moment the browser closes, which is exactly why closing it forced a fresh login. The token
// is a JWT with its own expiry, and the server rejects it once revoked — so persistence here
// costs nothing that logging out doesn't already handle.
const SESSION_KEY = "outcome:session";
// Per-tab last-open location (server + channel/DM + sidebar mode) so a page reload restores
// exactly where you were — a server channel or a DM with a friend — instead of dumping you on
// the primary server. This one STAYS in sessionStorage: it is deliberately per-tab, so two
// tabs can sit in different channels without fighting over one saved position.
const LOCATION_KEY = "outcome:location";
const log = createLogger("session");
let dispatcherCleanup: (() => void) | null = null;

/** Read the stored session, migrating one left behind in sessionStorage by an older build
 *  (otherwise everyone signed in today would be logged out by this very change). */
function readStoredSession(): { host?: string; token?: string; username?: string } | null {
  let raw = localStorage.getItem(SESSION_KEY);
  if (raw === null) {
    raw = sessionStorage.getItem(SESSION_KEY);
    if (raw !== null) {
      localStorage.setItem(SESSION_KEY, raw);
      sessionStorage.removeItem(SESSION_KEY);
    }
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as { host?: string; token?: string; username?: string };
  } catch {
    return null;
  }
}

/** Forget the stored session everywhere it could live (both storages, old builds included). */
export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

interface SavedLocation { serverId: number; channelId: number | null; mode: string }
/** A DM to re-select once its list finishes loading (DMs aren't in the scoped READY). */
let pendingDmRestore: number | null = null;
let locationPersistenceReady = false;

function readLocation(): SavedLocation | null {
  try {
    const raw = sessionStorage.getItem(LOCATION_KEY);
    if (!raw) return null;
    const l = JSON.parse(raw) as SavedLocation;
    if (typeof l.serverId === "number" && typeof l.mode === "string") return l;
  } catch { /* ignore */ }
  return null;
}

/** Snapshot the current view into sessionStorage (fires on every server/channel/mode change). */
function persistLocation(): void {
  if (!authStore.getState().token) return; // don't write while logged out
  const loc: SavedLocation = {
    serverId: getActiveServerId(),
    channelId: channelsStore.getState().activeChannelId,
    mode: uiStore.getState().sidebarMode,
  };
  try { sessionStorage.setItem(LOCATION_KEY, JSON.stringify(loc)); } catch { /* ignore */ }
}

/** Subscribe once so any navigation is remembered for the next reload. */
function initLocationPersistence(): void {
  if (locationPersistenceReady) return;
  locationPersistenceReady = true;
  serversStore.subscribe(persistLocation);
  channelsStore.subscribe(persistLocation);
  uiStore.subscribe(persistLocation);
}

/** Restore the saved view BEFORE connecting: pre-set the active server (so the WS auth requests
 *  the right tenant) + sidebar mode, and queue the channel/DM to select once data arrives. */
function applyLocationPrelude(): void {
  const loc = readLocation();
  if (!loc) return;
  if (loc.serverId > 0) setActiveServer(loc.serverId);
  if (loc.mode === "dms") {
    setSidebarMode("dms");
    if (loc.channelId != null) pendingDmRestore = loc.channelId; // applied after loadDmChannels
  } else {
    setSidebarMode("channels");
    if (loc.channelId != null) setPendingChannel(loc.channelId); // applied by the READY handler
  }
}

/** Select the queued DM once its list has loaded (no-op on a fresh login). */
function applyPendingDmRestore(): void {
  if (pendingDmRestore == null) return;
  const id = pendingDmRestore;
  pendingDmRestore = null;
  if (dmStore.getState().channels.some((d) => d.channelId === id)) {
    setActiveChannel(id);
    clearDmUnread(id);
  }
}

/** Wire post-auth: configure API token, connect the WS, attach the dispatcher. */
export function wirePostAuth(host: string, token: string, username: string): void {
  api.setConfig({ host, token });
  // Asset URLs (avatars, attachments) must resolve against the instance we signed into,
  // not the origin that served the SPA — they diverge when a custom server was picked.
  setServerHost(host);
  rememberLastHost(host);
  authStore.setState((prev) => ({ ...prev, token }));
  localStorage.setItem(SESSION_KEY, JSON.stringify({ host, token, username }));
  dispatcherCleanup?.();
  dispatcherCleanup = wireDispatcher(ws);
  ws.connect({ host, token });
  void loadServers();
  void loadFriends();
  // DM list is REST-only (READY doesn't carry it) — without this the DM sidebar is empty
  // after every page reload until the user re-opens a conversation manually. Once loaded, honor
  // a pending DM restore so a reload lands you back in the conversation you were reading.
  void loadDmChannels().then(applyPendingDmRestore);
  // Remember every subsequent navigation so the NEXT reload restores it.
  initLocationPersistence();
  // Auto-prompt for desktop-notification permission on the first interaction,
  // so message/call notifications work without visiting Settings.
  armNotificationPermissionPrompt();
}

/** Fetch the user's friends + pending requests into the friends store. Best-effort. */
export async function loadFriends(): Promise<void> {
  try {
    setFriendsList(await api.getFriends());
  } catch (err) {
    log.warn("Failed to load friends", err);
  }
}

/**
 * Fetch the servers the user belongs to and populate the store. If the active
 * server id is not among them, fall back to the first one. Best-effort: a
 * failure here leaves the default server id in place.
 */
export async function loadServers(): Promise<void> {
  try {
    const servers = await api.getServers();
    setServers(servers);
    if (servers.length > 0) {
      const activeId = getActiveServerId();
      if (!servers.some((s) => s.id === activeId)) {
        setActiveServer(servers[0]!.id);
      }
    } else {
      // Belongs to no server yet (e.g. registered without an invite) — land on the Home/DM
      // view instead of an empty tenant, and clear any stale active server id.
      setActiveServer(0);
      setSidebarMode("dms");
    }
  } catch (err) {
    log.warn("Failed to load servers", err);
  }
}

/**
 * Switch the active server: persist the new id, clear the active channel so the
 * fresh READY auto-selects the new server's first channel, then re-scope the
 * EXISTING WebSocket via a `switch_server` frame — NOT a reconnect. Keeping the
 * socket alive means an active voice session (LiveKit audio + server-side voice
 * presence) survives, so the user can browse/chat on other servers while still
 * talking in a voice channel elsewhere. REST requests pick up the new
 * X-Server-Id header automatically. Only joining a different voice channel
 * disconnects the previous voice.
 */
export function switchServer(id: number): void {
  if (serversStore.select((s) => s.activeServerId) === id) return;
  setActiveServer(id);
  setActiveChannel(null);
  // We stop receiving this server's live messages while scoped elsewhere, so any cached
  // history for it may be stale — force a REST refetch when its channels are next opened.
  invalidateLoadedChannels();
  ws.send({ type: "switch_server", payload: { server_id: id } });
}

/** Tear everything down and return to the connect screen. */
export function logout(): void {
  try { void api.logout(); } catch { /* ignore */ }
  ws.disconnect();
  dispatcherCleanup?.();
  dispatcherCleanup = null;
  clearStoredSession();
  sessionStorage.removeItem(LOCATION_KEY);
  // Back to same-origin: the login screen's setup/SSO probes must hit the instance that
  // serves the SPA, not linger on a foreign server. (The server field prefills from
  // the remembered last host, so reconnecting there is one click.)
  api.setConfig({ host: "", token: "" });
  setServerHost("");
  clearAuth();
  // Everything the account owned — conversations, channels, members, the composer. Without
  // this, signing in as somebody else showed the PREVIOUS person's chats until the page was
  // reloaded: the token and the socket were replaced, the stores were not.
  resetAccountStores();
}

/**
 * Is there a session to restore? Read SYNCHRONOUSLY, before the first paint, so the app can
 * show its boot splash instead of flashing the login form for the whole WS handshake
 * (isAuthenticated only flips on auth_ok, which is a round-trip away).
 */
export function hasStoredSession(): boolean {
  const s = readStoredSession();
  return typeof s?.token === "string" && s.token.length > 0;
}

/** Restore a saved session (page reload, or a fresh browser start). Returns true if restored. */
export function restoreSession(): boolean {
  const s = readStoredSession();
  if (!s) return false;
  try {
    // Only the token is required. An SSO sign-in stores an EMPTY username (the real profile
    // arrives with auth_ok) — requiring it here silently dropped SSO sessions on every full
    // page load, bouncing the user to the login form.
    if (s.token) {
      // Pre-apply the saved location so the WS auth requests the right server and the READY /
      // DM load lands us back where we were (a channel or a DM), not on the primary server.
      applyLocationPrelude();
      wirePostAuth(s.host ?? "", s.token, s.username ?? "");
      return true;
    }
  } catch { /* ignore */ }
  return false;
}
