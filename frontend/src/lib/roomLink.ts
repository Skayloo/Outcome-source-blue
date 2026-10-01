/**
 * One room link for everybody (W3GWG-25). A guest link opened by someone with an account here
 * puts a MEMBER of the room's server into the call as themselves, and keeps that intent across
 * a sign-in: the link is opened once, the person signs in, and they are in the room — nobody
 * has to find and open the link a second time. Anyone who is not a member stays a guest; the
 * link is a seat in one room, not a way into the server.
 *
 * The intent rides sessionStorage, not the URL: it has to survive the login screen and an SSO
 * round-trip in the same tab, and a "join this call" left in the address bar would fire again
 * on every reload.
 */
import { api } from "@lib/services";
import { joinVoice } from "@lib/voice";
import { switchServer } from "@lib/session";
import { channelsStore, setActiveChannel, setPendingChannel } from "@stores/channels.store";
import { getActiveServerId } from "@stores/servers.store";
import { setSidebarMode, setTransientError } from "@stores/ui.store";
import { t } from "@lib/i18n";
import { createLogger } from "@lib/logger";

const log = createLogger("roomLink");
const KEY = "outcome:roomLink";
/** Long enough for a sign-in, a forgotten password or an SSO detour; short enough that an
 *  abandoned attempt does not pull someone into a call the next time they open the app. */
const MAX_AGE_MS = 15 * 60_000;

/** A room to join once the READY of its server has arrived (see followRoomLink). */
let joinAfterSwitch: { channelId: number; at: number } | null = null;

/** Remember to enter the room behind `code` once signed in. */
export function rememberRoomLink(code: string): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() })); } catch { /* private mode */ }
}

function takeRoomLink(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(KEY);
    const v = JSON.parse(raw) as { code?: unknown; at?: unknown };
    if (typeof v.code !== "string" || typeof v.at !== "number" || Date.now() - v.at > MAX_AGE_MS) return null;
    return v.code;
  } catch {
    return null;
  }
}

/**
 * Called on every READY. Follows a remembered link once: a member is taken to the room's server
 * and into the call; anyone else goes back to the guest page, which now knows who they are and
 * fills in their name.
 */
export async function followRoomLink(): Promise<void> {
  // The guest page runs the app's session in the background; following from there would race
  // the navigation the page itself is about to make.
  if (window.location.pathname.startsWith("/guest/")) return;
  // Second half of a switch made below: this READY is the room's server, so join now.
  if (joinAfterSwitch !== null) {
    const { channelId, at } = joinAfterSwitch;
    if (channelsStore.getState().channels.has(channelId)) {
      joinAfterSwitch = null;
      joinVoice(channelId);
    } else if (Date.now() - at > 60_000) {
      joinAfterSwitch = null;
    }
    return;
  }
  const code = takeRoomLink();
  if (code === null) return;
  try {
    const r = await api.getGuestAccount(code);
    if (!r.member) {
      window.location.assign(`/guest/${encodeURIComponent(code)}`);
      return;
    }
    setSidebarMode("channels");
    if (getActiveServerId() !== r.server_id) {
      // The scoped READY that answers the switch selects this channel, and only THEN do we join.
      // Joining first raced that READY: it found a call in progress and re-announced it, the
      // server answered with a second token mid-connect, and the first room's teardown cleared
      // the call from the UI while LiveKit stayed connected on the second.
      setPendingChannel(r.channel_id);
      joinAfterSwitch = { channelId: r.channel_id, at: Date.now() };
      switchServer(r.server_id);
    } else {
      setActiveChannel(r.channel_id);
      joinVoice(r.channel_id);
    }
  } catch (e) {
    log.warn("room link could not be followed", e);
    setTransientError(t("guest.linkFollowFailed"));
  }
}
