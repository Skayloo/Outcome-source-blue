// Reactions and raised hands in a voice room.
//
// Both travel over LiveKit, not over our own socket, and that is the whole design decision:
// guests are not on our socket at all — they have a link and a room — and the meetings that
// want these are held on guest links. A feature half the room cannot use is not a feature.
//
// The two use different primitives on purpose:
//
//   • a REACTION is a moment. It is a data message, it is lost if you were not looking, and
//     that is correct — nobody wants yesterday's applause replayed on join.
//   • a RAISED HAND is a state. It is a participant attribute, so it survives someone joining
//     late and clears itself when its owner leaves — no cleanup protocol, no ghost hands.
//
// EVERYTHING ARRIVING HERE IS UNTRUSTED, guests included: the emoji must be one of the fixed
// handful below, and anything faster than one per 700 ms per sender is dropped. The grant on
// the token is not the defence; this is.
import { RoomEvent, type Room, type RemoteParticipant, type Participant } from "livekit-client";

/** The set Meet settled on, and the reason to keep it short: a picker with forty faces is a
 *  menu, and a menu is slower than saying the word out loud. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "👏", "🎉"] as const;
export type Reaction = (typeof REACTIONS)[number];

const TOPIC = "fx";
const HAND_ATTR = "hand";
/** One reaction per sender per this many ms. Not a fairness rule — a defence: the sender can
 *  be anyone with the link. */
const MIN_GAP_MS = 700;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Local echo.
 *
 * LiveKit does NOT deliver your own data back to you — DataReceived fires for remote senders
 * only. Everyone else saw the reaction and the person who sent it did not, which reads as a
 * broken button. So the sender is told directly, and subscribers cannot tell the difference.
 */
const localListeners = new Set<(identity: string, emoji: Reaction) => void>();

function isReaction(value: unknown): value is Reaction {
  return typeof value === "string" && (REACTIONS as readonly string[]).includes(value);
}

/** Fire a reaction at the room. Lossy by choice: a dropped one is a moment missed, and
 *  retransmitting it late would land it under the wrong sentence. */
export async function sendReaction(room: Room, emoji: Reaction): Promise<void> {
  if (!isReaction(emoji)) return;
  const identity = room.localParticipant.identity;
  for (const listener of localListeners) listener(identity, emoji);
  await room.localParticipant.publishData(
    encoder.encode(JSON.stringify({ k: "r", e: emoji })),
    { reliable: false, topic: TOPIC },
  );
}

/** Raise or lower our own hand. The value is the moment it went up, so a room can be worked
 *  in the order people asked — first up, first answered. */
export async function setHandRaised(room: Room, up: boolean): Promise<void> {
  await room.localParticipant.setAttributes({ [HAND_ATTR]: up ? String(Date.now()) : "" });
}

/** When this participant raised their hand, or null. */
export function handRaisedAt(p: Participant): number | null {
  const raw = p.attributes?.[HAND_ATTR];
  if (raw === undefined || raw === "") return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Every hand currently up, keyed by participant identity, oldest first. */
export function raisedHands(room: Room): Map<string, number> {
  const out = new Map<string, number>();
  const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const p of all) {
    const at = handRaisedAt(p);
    if (at !== null) out.set(p.identity, at);
  }
  return new Map([...out].sort((a, b) => a[1] - b[1]));
}

/**
 * Subscribe to reactions. The callback gets the sender's identity and the emoji; returns an
 * unsubscribe. Own reactions arrive through the local echo above — you should see your own
 * applause, and LiveKit will not send it back to you.
 */
export function onReaction(room: Room, cb: (identity: string, emoji: Reaction) => void): () => void {
  const lastAt = new Map<string, number>();
  const handler = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string): void => {
    if (topic !== TOPIC) return;
    const identity = participant?.identity ?? room.localParticipant.identity;
    const now = Date.now();
    if (now - (lastAt.get(identity) ?? 0) < MIN_GAP_MS) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(payload));
    } catch {
      return; // not ours, or not JSON — either way, not our problem
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as { k?: unknown; e?: unknown };
    if (msg.k !== "r" || !isReaction(msg.e)) return;
    lastAt.set(identity, now);
    cb(identity, msg.e);
  };
  const localHandler = (identity: string, emoji: Reaction): void => cb(identity, emoji);
  localListeners.add(localHandler);
  room.on(RoomEvent.DataReceived, handler);
  return () => {
    localListeners.delete(localHandler);
    room.off(RoomEvent.DataReceived, handler);
  };
}
