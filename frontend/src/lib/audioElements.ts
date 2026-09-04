// AudioElements — manages remote audio elements (mic + screenshare)
//
// Handles HTMLAudioElement lifecycle for remote participants' audio tracks,
// per-user volume, screenshare audio volume/mute, and output device routing.

import {
  Track,
  type Room,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { parseUserId } from "@lib/livekitSession";
import { nextNormGain } from "@lib/loudnessNorm";

const log = createLogger("audioElements");

/** Hard gain ceiling, as a percentage. Boosts past 2× audibly clip/crackle (the GainNode
 *  amplifies into digital clipping), so the cap is enforced at every write AND read —
 *  prefs saved by older builds could hold up to 400. */
const MAX_VOLUME_PCT = 200;

/** Get saved per-user volume (0-200 range, default 100). Applied via LiveKit's GainNode-backed setVolume(). */
function getSavedUserVolume(userId: number): number {
  return Math.min(loadPref<number>(`userVolume_${userId}`, 100), MAX_VOLUME_PCT);
}

export class AudioElements {
  private room: Room | null = null;

  /** Remote microphone audio elements keyed by track SID for cleanup on disconnect. */
  private remoteMicAudioElements = new Map<string, HTMLAudioElement>();
  /** Screenshare audio elements keyed by userId — separate from mic audio pipeline. */
  private screenshareAudioElements = new Map<number, Set<HTMLAudioElement>>();
  /** Persisted mute state for screenshare audio so replacement tracks inherit UI state. */
  private screenshareAudioMutedByUser = new Map<number, boolean>();

  /** Master output volume multiplier (0-2.0). Per-user volumes are scaled by this. */
  private outputVolumeMultiplier: number;

  // --- Receive-side loudness normalisation ------------------------------------------------
  // The ONE place a difference in loudness between people may be corrected. On the sending
  // side the browser's AGC already regulates, and a second regulator racing it is what made
  // the same person deafening in Chrome and quiet in Firefox. Here every voice is measured
  // against the same target, on one listener's machine, and nobody's signal is rewritten for
  // everyone else. See loudnessNorm.ts for the arithmetic and its check.
  private ctx: AudioContext | null = null;
  /** Passive taps: a source and an analyser per speaker, connected to NOTHING downstream. */
  private levelTaps = new Map<number, { src: MediaStreamAudioSourceNode; an: AnalyserNode; buf: Float32Array<ArrayBuffer> }>();
  private normGain = new Map<number, number>();
  private normTimer: ReturnType<typeof setInterval> | null = null;

  /** The page's AudioContext, handed over once voice is up. Without it there is no measuring
   *  and normalisation simply does not happen — everything else works as before. */
  setContext(ctx: AudioContext | null): void {
    if (ctx === this.ctx) return;
    this.ctx = ctx;
    if (ctx === null) this.stopNormalising();
  }

  private addLevelTap(userId: number, track: MediaStreamTrack): void {
    const ctx = this.ctx;
    if (ctx === null || userId <= 0 || this.levelTaps.has(userId)) return;
    try {
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an); // and no further: a reading, not a stage
      this.levelTaps.set(userId, { src, an, buf: new Float32Array(new ArrayBuffer(an.fftSize * 4)) });
      this.startNormalising();
    } catch (err) {
      log.debug("could not tap remote level", err);
    }
  }

  private removeLevelTap(userId: number): void {
    const tap = this.levelTaps.get(userId);
    if (tap === undefined) return;
    tap.src.disconnect();
    tap.an.disconnect();
    this.levelTaps.delete(userId);
    this.normGain.delete(userId);
    if (this.levelTaps.size === 0) this.stopNormalising();
  }

  // 400 ms: slow enough that four ticks are a second of speech, which is the timescale the
  // correction is allowed to move on. Faster and the listener hears it working.
  private startNormalising(): void {
    if (this.normTimer !== null) return;
    this.normTimer = setInterval(() => this.tickNormalise(), 400);
  }

  private stopNormalising(): void {
    if (this.normTimer !== null) { clearInterval(this.normTimer); this.normTimer = null; }
    for (const userId of [...this.levelTaps.keys()]) this.removeLevelTap(userId);
  }

  private tickNormalise(): void {
    for (const [userId, tap] of this.levelTaps) {
      tap.an.getFloatTimeDomainData(tap.buf);
      let sum = 0;
      for (const v of tap.buf) sum += v * v;
      const rms = Math.sqrt(sum / tap.buf.length);
      const before = this.normGain.get(userId) ?? 1;
      const after = nextNormGain(before, rms);
      if (Math.abs(after - before) < 1e-4) continue;
      this.normGain.set(userId, after);
      this.applyVolume(userId);
    }
  }

  private applyVolume(userId: number): void {
    const participant = [...(this.room?.remoteParticipants.values() ?? [])]
      .find((p) => parseUserId(p.identity) === userId);
    participant?.setVolume(this.getEffectiveVolume(userId));
  }

  constructor() {
    this.outputVolumeMultiplier = Math.min(loadPref<number>("outputVolume", 100), MAX_VOLUME_PCT) / 100;
  }

  setRoom(room: Room | null): void {
    this.room = room;
  }

  /**
   * Mute the <audio> elements whose sound the Web Audio graph is already carrying.
   *
   * LiveKit mutes an element itself — but only when the AudioContext is on the track at the
   * moment of attach (RemoteAudioTrack.attach). Safari hands the context over LATER, because
   * it waits for a gesture, and setAudioContext() then wires up the graph without touching the
   * element that is already playing. Both paths run, a few milliseconds apart, and every voice
   * in the room is heard twice.
   *
   * Only ever called once playback has actually started through a context we own; if the graph
   * were not carrying the audio, these elements would be the only thing anyone could hear.
   */
  silenceDoubledElements(): void {
    for (const el of this.remoteMicAudioElements.values()) {
      if (el.muted) continue;
      el.muted = true;
      el.volume = 0;
    }
  }

  /** What each speaker is arriving at, and what we are doing about it. For the voice report. */
  remoteLevels(): Array<{ userId: number; rms: number; norm: number; volume: number }> {
    const out: Array<{ userId: number; rms: number; norm: number; volume: number }> = [];
    for (const [userId, tap] of this.levelTaps) {
      tap.an.getFloatTimeDomainData(tap.buf);
      let sum = 0;
      for (const v of tap.buf) sum += v * v;
      out.push({
        userId,
        rms: Math.sqrt(sum / tap.buf.length),
        norm: this.normGain.get(userId) ?? 1,
        volume: this.getEffectiveVolume(userId),
      });
    }
    return out;
  }

  /** Get the current output volume multiplier. */
  getOutputVolumeMultiplier(): number {
    return this.outputVolumeMultiplier;
  }

  /** Compute the effective volume for a participant: per-user volume * master output. */
  getEffectiveVolume(userId: number): number {
    const userVol = userId > 0 ? getSavedUserVolume(userId) : 100;
    // The normalisation factor rides on top of both, so a listener who drags someone's slider
    // still gets exactly what they asked for, relative to a voice that is already levelled.
    const norm = userId > 0 ? (this.normGain.get(userId) ?? 1) : 1;
    return (userVol / 100) * this.outputVolumeMultiplier * norm;
  }

  private getScreenshareOutputVolume(): number {
    return Math.max(0, Math.min(1, this.outputVolumeMultiplier));
  }

  // --- Track subscription handlers ---

  handleTrackSubscribedAudio(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    const userId = parseUserId(participant.identity);
    if (publication.source === Track.Source.ScreenShareAudio) {
      // Screenshare audio: manage via HTMLAudioElement volume (not participant.setVolume)
      for (const el of track.detach()) el.remove();
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      audioEl.volume = this.getScreenshareOutputVolume();
      audioEl.muted = this.screenshareAudioMutedByUser.get(userId) ?? false;
      let audioEls = this.screenshareAudioElements.get(userId);
      if (audioEls === undefined) {
        audioEls = new Set();
        this.screenshareAudioElements.set(userId, audioEls);
      }
      audioEls.add(audioEl);
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch((err) => {
          log.warn("Failed to set output device on screenshare audio", err);
        });
      }
      log.debug("Screenshare audio track subscribed and attached", { userId, trackSid: track.sid });
    } else {
      // Microphone audio: use LiveKit's GainNode-backed setVolume
      // Detach any previous <audio> elements to prevent duplicate playback
      // on fast reconnects (new subscription fires before old unsubscription)
      for (const el of track.detach()) el.remove();
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      // Track mic audio elements for cleanup on abnormal disconnect
      if (track.sid !== undefined) {
        this.remoteMicAudioElements.set(track.sid, audioEl);
      }
      this.addLevelTap(userId, track.mediaStreamTrack);
      // Apply saved per-user volume via LiveKit's setVolume (supports 0-2.0 range)
      participant.setVolume(this.getEffectiveVolume(userId));
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch((err) => {
          log.warn("Failed to set output device on remote audio", err);
        });
      }
      log.debug("Remote audio track subscribed and attached", { userId, trackSid: track.sid });
    }
  }

  handleTrackUnsubscribedAudio(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    const userId = parseUserId(participant.identity);
    if (publication.source === Track.Source.ScreenShareAudio) {
      const detachedEls = track.detach() as HTMLAudioElement[];
      for (const el of detachedEls) el.remove();
      const audioEls = this.screenshareAudioElements.get(userId);
      if (audioEls !== undefined) {
        for (const el of detachedEls) audioEls.delete(el);
        if (audioEls.size === 0) this.screenshareAudioElements.delete(userId);
      }
      log.debug("Screenshare audio track unsubscribed and detached", { userId, trackSid: track.sid });
    } else {
      for (const el of track.detach()) el.remove();
      if (track.sid !== undefined) this.remoteMicAudioElements.delete(track.sid);
      this.removeLevelTap(userId);
      log.debug("Remote audio track unsubscribed and detached", { userId, trackSid: track.sid });
    }
  }

  // --- Remote audio subscription state (deafen) ---

  applyRemoteAudioSubscriptionState(deafened: boolean): void {
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        publication.setSubscribed(!deafened);
      }
    }
  }

  // --- Volume control ---

  /** Apply effective volume to all remote participants. */
  applyAllVolumes(): void {
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      const userId = parseUserId(participant.identity);
      participant.setVolume(this.getEffectiveVolume(userId));
    }
  }

  setUserVolume(userId: number, volume: number): void {
    const clamped = Math.max(0, Math.min(MAX_VOLUME_PCT, volume));
    savePref(`userVolume_${userId}`, clamped);
    if (this.room !== null) {
      for (const participant of this.room.remoteParticipants.values()) {
        if (parseUserId(participant.identity) === userId) {
          participant.setVolume((clamped / 100) * this.outputVolumeMultiplier);
        }
      }
    }
  }

  getUserVolume(userId: number): number { return getSavedUserVolume(userId); }

  setOutputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(MAX_VOLUME_PCT, volume));
    savePref("outputVolume", clamped);
    this.outputVolumeMultiplier = clamped / 100;
    this.applyAllVolumes();
    const screenshareVolume = this.getScreenshareOutputVolume();
    for (const audioEls of this.screenshareAudioElements.values()) {
      for (const audioEl of audioEls) {
        audioEl.volume = screenshareVolume;
      }
    }
  }

  // --- Screenshare audio ---

  setScreenshareAudioVolume(userId: number, volume: number): void {
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return;
    const clamped = Math.max(0, Math.min(1, volume));
    for (const el of audioEls) el.volume = clamped;
  }

  muteScreenshareAudio(userId: number, muted: boolean): void {
    this.screenshareAudioMutedByUser.set(userId, muted);
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return;
    for (const el of audioEls) el.muted = muted;
  }

  getScreenshareAudioMuted(userId: number): boolean {
    const storedMuted = this.screenshareAudioMutedByUser.get(userId);
    if (storedMuted !== undefined) return storedMuted;
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return false;
    for (const el of audioEls) return el.muted;
    return false;
  }

  // --- Cleanup ---

  /** Remove all remote audio elements from the DOM and clear tracking maps. */
  cleanupAllAudioElements(): void {
    this.stopNormalising();
    for (const el of this.remoteMicAudioElements.values()) el.remove();
    this.remoteMicAudioElements.clear();
    for (const audioEls of this.screenshareAudioElements.values()) {
      for (const el of audioEls) el.remove();
    }
    this.screenshareAudioElements.clear();
    this.screenshareAudioMutedByUser.clear();
  }
}
