import { ws, wsSend } from "./services";
import { voiceStore, joinVoiceChannel, leaveVoiceChannel } from "@stores/voice.store";
import {
  leaveVoice as sessionLeave,
  setMuted as sessionSetMuted,
  setDeafened as sessionSetDeafened,
  setWsClient,
  setServerHost,
} from "@lib/livekitSession";

let inited = false;
let cueCtx: AudioContext | null = null;

/** Play a short two-tone cue when joining (ascending) or leaving (descending) voice.
 *  Exported so the dispatcher can also chime when OTHER users enter/leave my channel. */
export function playVoiceCue(kind: "join" | "leave"): void {
  try {
    cueCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = cueCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const freqs = kind === "join" ? [523.25, 783.99] : [783.99, 523.25]; // C5→G5 / G5→C5
    const now = ctx.currentTime;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.connect(g);
      g.connect(ctx.destination);
      const t = now + i * 0.11;
      osc.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      osc.start(t);
      osc.stop(t + 0.14);
    });
  } catch { /* audio blocked until a gesture */ }
}

// ── Call ringtone (phone-style, looping, distinct melody) ────────────────────
let ringCtx: AudioContext | null = null;
let ringTimer: number | null = null;

/** Start a looping ringtone for an incoming/outgoing call — a bright 4-note arpeggio
 *  repeating every 2s (deliberately different from the join/leave two-tone cue). */
export function startCallRingtone(): void {
  try {
    ringCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = ringCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const pattern = (): void => {
      const notes = [659.25, 830.61, 987.77, 830.61]; // E5 · G#5 · B5 · G#5
      const now = ctx.currentTime;
      notes.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.connect(g);
        g.connect(ctx.destination);
        const t = now + i * 0.18;
        osc.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
        osc.start(t);
        osc.stop(t + 0.2);
      });
    };
    if (ringTimer !== null) return; // already ringing
    pattern();
    ringTimer = window.setInterval(pattern, 2000);
  } catch { /* audio blocked until a gesture */ }
}

/** Stop the looping ringtone. */
export function stopCallRingtone(): void {
  if (ringTimer !== null) {
    window.clearInterval(ringTimer);
    ringTimer = null;
  }
}

/** Wire the LiveKit session to the WS client + server host (call once on app mount). */
export function initVoice(): void {
  if (inited) return;
  inited = true;
  setWsClient(ws);
  setServerHost(window.location.host);
}

/** Join a voice channel: optimistic UI + voice_join (server replies with voice_token). */
export function joinVoice(channelId: number): void {
  if (voiceStore.getState().currentChannelId === channelId) return;
  joinVoiceChannel(channelId);
  wsSend("voice_join", { channel_id: channelId });
  playVoiceCue("join");
}

/** Leave voice: disconnect LiveKit + send voice_leave + reset store. */
export function leaveVoiceNow(): void {
  playVoiceCue("leave");
  sessionLeave(true);
  leaveVoiceChannel();
}

/** The account joined voice from ANOTHER browser/device: hand the session over — tear
 *  down local media WITHOUT a voice_leave (that would evict the new device's roster row). */
export function leaveVoiceLocal(): void {
  sessionLeave(false);
  leaveVoiceChannel(true); // still in the call — just not from this device
}

export function toggleMute(): void {
  sessionSetMuted(!voiceStore.getState().localMuted);
}

export function toggleDeafen(): void {
  sessionSetDeafened(!voiceStore.getState().localDeafened);
}
