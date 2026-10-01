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

/** Four rows of six — the first row is the original set, so the everyday ones stay where
 *  hands expect them. Still one glance, not a menu: past this a picker becomes a search.
 *
 *  MUST equal VoiceService.reactions in the iOS app, in order. Each side drops what is not on
 *  its own list, so a face added on one side alone is silently invisible on the other. Single
 *  code points only: a ZWJ sequence falls apart into pieces on an older system font. */
export const REACTIONS = [
  "👍", "❤️", "😂", "😮", "👏", "🎉",
  "🤡", "🔥", "👎", "😢", "🤔", "🙏",
  "💯", "👀", "🤯", "😡", "😱", "😍",
  "🥳", "💩", "🗿", "😎", "💀", "🤝",
] as const;
export type Reaction = (typeof REACTIONS)[number];

/** A GIF reaction: a path to one of OUR files (the sender's library, see lib/gifs.ts). A path, not
 *  a URL — a link to anywhere would make every participant's client fetch from a server of the
 *  sender's choosing, which is a tracking pixel aimed at a whole meeting. */
export interface GifFx { readonly gif: string }
/** What can float out of a tile: one of the emoji, or a GIF. */
export type Fx = Reaction | GifFx;

/** Our own file paths only: `/api/v1/files/<id>`, optionally with the signature query the
 *  server puts on it. Anything else — a scheme, a host, `..` — is not a GIF reaction. */
const GIF_PATH = /^\/api\/v1\/files\/[A-Za-z0-9_-]{1,80}(\?[A-Za-z0-9=&%._-]{0,400})?$/;
export function isGifPath(value: unknown): value is string {
  return typeof value === "string" && GIF_PATH.test(value);
}

const TOPIC = "fx";
const HAND_ATTR = "hand";
/** One reaction per sender per this many ms. Not a fairness rule — a defence: the sender can
 *  be anyone with the link. */
const MIN_GAP_MS = 700;
/** GIFs are heavier: every participant downloads the file. One per sender per this many ms. */
const GIF_MIN_GAP_MS = 2500;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Local echo.
 *
 * LiveKit does NOT deliver your own data back to you — DataReceived fires for remote senders
 * only. Everyone else saw the reaction and the person who sent it did not, which reads as a
 * broken button. So the sender is told directly, and subscribers cannot tell the difference.
 */
const localListeners = new Set<(identity: string, fx: Fx) => void>();

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

/** Fire a GIF from the sender's library at the room. Same lossy channel as the emoji. */
export async function sendGif(room: Room, path: string): Promise<void> {
  if (!isGifPath(path)) return;
  const identity = room.localParticipant.identity;
  for (const listener of localListeners) listener(identity, { gif: path });
  await room.localParticipant.publishData(
    encoder.encode(JSON.stringify({ k: "g", u: path })),
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

/** "rec" is set by the SERVER (voice_record) on whoever is recording the call, never by a
 *  client, so a banner built on it cannot be faked away by the recorder. */
const REC_ATTR = "rec";

/** Everyone recording the call right now: participant identity → since when. */
export function recordersIn(room: Room): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of [room.localParticipant, ...room.remoteParticipants.values()] as Participant[]) {
    const ms = Number(p.attributes?.[REC_ATTR] ?? "");
    if (Number.isFinite(ms) && ms > 0) out.set(p.identity, ms);
  }
  return out;
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
export function onReaction(room: Room, cb: (identity: string, fx: Fx) => void): () => void {
  const lastAt = new Map<string, number>();
  const lastGifAt = new Map<string, number>();
  const handler = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string): void => {
    if (topic !== TOPIC) return;
    const identity = participant?.identity ?? room.localParticipant.identity;
    const now = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(payload));
    } catch {
      return; // not ours, or not JSON — either way, not our problem
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as { k?: unknown; e?: unknown; u?: unknown };
    if (msg.k === "r" && isReaction(msg.e)) {
      if (now - (lastAt.get(identity) ?? 0) < MIN_GAP_MS) return;
      lastAt.set(identity, now);
      cb(identity, msg.e);
    } else if (msg.k === "g" && isGifPath(msg.u)) {
      if (now - (lastGifAt.get(identity) ?? 0) < GIF_MIN_GAP_MS) return;
      lastGifAt.set(identity, now);
      cb(identity, { gif: msg.u });
    }
  };
  const localHandler = (identity: string, fx: Fx): void => cb(identity, fx);
  localListeners.add(localHandler);
  room.on(RoomEvent.DataReceived, handler);
  return () => {
    localListeners.delete(localHandler);
    room.off(RoomEvent.DataReceived, handler);
  };
}

/**
 * A short rising blip when somebody raises a hand — everyone in the room hears it, which is the
 * entire point: a hand nobody notices is a hand that was not raised.
 *
 * Synthesised rather than a file for the same reason the join/leave cue is: two oscillators
 * cost nothing, need no asset pipeline, and cannot 404. It lives here rather than in voice.ts
 * because livekitSession already imports this module and importing voice.ts back would close a
 * cycle.
 */
let cueCtx: AudioContext | null = null;
export function playHandCue(): void {
  try {
    cueCtx ??= new AudioContext();
    const ctx = cueCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    [880, 1174.66].forEach((f, i) => { // A5 → D6, upward: something is being asked for
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.connect(g);
      g.connect(ctx.destination);
      const t = now + i * 0.12;
      osc.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.start(t);
      osc.stop(t + 0.17);
    });
  } catch { /* audio still locked behind a gesture — the badge is enough */ }
}
