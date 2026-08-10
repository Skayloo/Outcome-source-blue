/**
 * 1-on-1 call orchestration. Signaling is relayed over WS (call_offer/accept/decline/cancel);
 * the actual media is a LiveKit session joined on the pair's DM channel. Phone-style:
 * caller rings (ringback), callee gets an incoming modal + ringtone, accept → both joinVoice.
 */
import { api, wsSend } from "@lib/services";
import { joinVoice, startCallRingtone, stopCallRingtone } from "@lib/voice";
import { stopTitleFlash, closeCallNotification } from "@lib/notifications";
import { enterDmView } from "@lib/dm";
import { setActiveChannel } from "@stores/channels.store";
import {
  callStore,
  setOutgoingCall,
  clearOutgoingCall,
  clearIncomingCall,
  setActiveCall,
} from "@stores/call.store";
import { createLogger } from "@lib/logger";

const log = createLogger("call");

// How long the caller rings an unanswered callee before giving up (missed call). Kept in step with
// the server-side pending-call TTL so a call that outlives the ring window can't pop stale later.
const RING_TIMEOUT_MS = 45_000;
let ringTimer: ReturnType<typeof setTimeout> | null = null;

function clearRingTimer(): void {
  if (ringTimer !== null) {
    clearTimeout(ringTimer);
    ringTimer = null;
  }
}

/** Place a call to a user: ensure a DM channel exists, ring them, play ringback. */
export async function startCall(userId: number, username: string): Promise<void> {
  try {
    const r = await api.createDm(userId);
    setOutgoingCall({ calleeId: userId, calleeName: username, channelId: r.channel_id });
    wsSend("call_offer", { callee_id: userId, channel_id: r.channel_id });
    startCallRingtone();
    // Auto-hang-up if nobody picks up (e.g. the callee never comes online within the ring window).
    clearRingTimer();
    ringTimer = setTimeout(() => cancelCall(), RING_TIMEOUT_MS);
  } catch (e) {
    log.warn("startCall failed", e);
    clearOutgoingCall();
    stopCallRingtone();
  }
}

/** Accept the current incoming call: stop ringing, tell the caller, join the DM voice room. */
export function acceptCall(): void {
  const c = callStore.getState().incoming;
  if (!c) return;
  stopCallRingtone();
  stopTitleFlash();
  closeCallNotification();
  clearIncomingCall();
  wsSend("call_accept", { caller_id: c.callerId, channel_id: c.channelId });
  setActiveCall(c.channelId);
  enterDmView(); // the DM call lives in the Home view, like Discord
  setActiveChannel(c.channelId);
  joinVoice(c.channelId);
}

/** Decline the current incoming call. */
export function declineCall(): void {
  const c = callStore.getState().incoming;
  if (!c) return;
  stopCallRingtone();
  stopTitleFlash();
  closeCallNotification();
  clearIncomingCall();
  wsSend("call_decline", { caller_id: c.callerId });
}

/** Cancel the current outgoing call (before it's answered). */
export function cancelCall(): void {
  clearRingTimer();
  const c = callStore.getState().outgoing;
  if (!c) return;
  stopCallRingtone();
  clearOutgoingCall();
  wsSend("call_cancel", { callee_id: c.calleeId });
}
