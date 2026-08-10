// AudioPipeline — unified audio pipeline: input volume + VAD gating
//
// Architecture:
//   rawMicTrack → AudioContext source
//       ├──→ AnalyserNode (VAD reads raw audio here — always sees real signal)
//       └──→ GainNode (inputVolume × vadGate) → MediaStreamDestination → WebRTC sender
//
// The pipeline is always active while in a voice session. This avoids
// creating/destroying it when volume changes, and gives the VAD a stable
// analyser that's independent of LiveKit's track lifecycle.

import { Track, type Room, type LocalAudioTrack } from "livekit-client";
import { loadPref, savePref } from "@components/settings/helpers";
// The local "you're talking" ring is driven by a CLIENT-SIDE mic level monitor
// (Discord-style: computed locally from the mic, independent of the SFU's
// active-speaker round-trip which does not reliably include the local user).
import { setLocalSpeaking, voiceStore } from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { createRNNoiseProcessor } from "@lib/noise-suppression";
import { createDeepFilterProcessor, deepFilterWarmed, prefetchDeepFilter, suppressionLevel, supportsDeepFilter } from "@lib/noise-suppression-dfn";

const log = createLogger("audioPipeline");


/**
 * Microphone capture constraints, with the one rule that matters: never run two noise
 * suppressors in series.
 *
 * Every denoiser is trained on a raw noisy signal. Hand it audio the browser has already
 * gated and it over-suppresses — chewed word onsets, pumping between phrases, that
 * underwater timbre — while the residual hum it was supposed to remove survives anyway,
 * because the browser's stage already flattened the cues the model reads. So when the
 * enhanced suppressor is on, the browser's own is off, and it owns the signal alone.
 */
export function micCaptureOptions(): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
  const enhanced = loadPref<boolean>("enhancedNoiseSuppression", true);
  return {
    // Echo cancellation stays: it runs before everything else, which is where it belongs,
    // and nothing downstream can undo a speaker bleeding into the microphone.
    echoCancellation: loadPref("echoCancellation", true),
    // Two suppressors in series over-suppress and leave the hum anyway — ours is the only
    // one on the signal whenever it is running.
    noiseSuppression: enhanced ? false : loadPref("noiseSuppression", true),
    // AGC STAYS ON, and the theory that said otherwise lost to the evidence. Switching it
    // off was meant to hand the model a steadier noise floor, since the browser applies it
    // before our worklet. But the filter was already doing its job with AGC on, and without
    // it everyone came through at about half the volume — AGC is what makes a call sound as
    // even and as loud as Meet does. An improvement nobody could hear is not worth halving
    // the loudness of every voice.
    autoGainControl: loadPref("autoGainControl", true),
  };
}

export class AudioPipeline {
  private room: Room | null = null;

  // Pipeline nodes
  private audioPipelineCtx: AudioContext | null = null;
  private audioPipelineGain: GainNode | null = null;
  private audioPipelineAnalyser: AnalyserNode | null = null;
  private audioPipelineDest: MediaStreamAudioDestinationNode | null = null;
  private vadTimer: ReturnType<typeof setTimeout> | null = null;
  /** When true, mic is currently gated (muted by VAD — gain set to 0). */
  private vadGated = false;
  /** The user's input volume gain (0-2.0). VAD multiplies this by 0 or 1. */
  private currentInputGain = 1.0;

  setRoom(room: Room | null): void {
    this.room = room;
  }

  /** Whether the audio pipeline is currently active (has a GainNode). */
  get isActive(): boolean {
    return this.audioPipelineGain !== null;
  }

  /** Current gain value from the pipeline GainNode, or null if inactive. */
  get gainValue(): number | null {
    return this.audioPipelineGain?.gain.value ?? null;
  }

  /** Current AudioContext state, or null if inactive. */
  get ctxState(): string | null {
    return this.audioPipelineCtx?.state ?? null;
  }

  /** Whether VAD is currently gating audio. */
  get isVadGated(): boolean {
    return this.vadGated;
  }

  /** Current input gain multiplier. */
  get inputGain(): number {
    return this.currentInputGain;
  }

  /** Engine AND depth of what is on the track, so any change to either can tell it needs
   *  to swap. Keying on the engine alone made the strength slider a no-op. */
  private attachedEngine: string | null = null;

  /** What is on the mic right now — "deepfilter:50", "rnnoise", or null. The settings screen
   *  shows this rather than the preference, because the two differ on a first call. */
  get activeEngine(): string | null {
    return this.attachedEngine;
  }

  // --- Noise suppressor (LiveKit TrackProcessor API) ---

  /**
   * Attach the noise suppressor to the local mic track. Safe to call if already attached.
   *
   * ONE processor per call, decided before the graph is built and never swapped underneath
   * it.
   *
   * The previous design put RNNoise on immediately and swapped DeepFilterNet in a second
   * later, so the microphone never waited on a download. It also swapped the track twice —
   * and this pipeline OWNS the sender, replacing its track with the graph's own output.
   * After the second swap the analyser was reading a track nothing flowed through any more,
   * which is why the speaking ring went dark mid-sentence, and two un-awaited replaceTrack
   * calls raced for the sender. Not worth what it bought.
   *
   * So: if the model is already in the browser cache, DeepFilterNet goes on directly. If it
   * is not, this call gets RNNoise and the model is fetched in the background for the next
   * one. First call on a machine is the weaker filter; every call after it is the strong one.
   */
  async applyNoiseSuppressor(): Promise<void> {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;

    const wantDeep = loadPref<string>("nsEngine", "deepfilter") === "deepfilter" && supportsDeepFilter();
    const deepReady = wantDeep && deepFilterWarmed();
    const key = deepReady ? `deepfilter:${suppressionLevel()}` : "rnnoise";

    if (micPub.track.getProcessor() !== undefined) {
      if (this.attachedEngine === key) return;
      await micPub.track.stopProcessor();
      this.attachedEngine = null;
    }

    try {
      const processor = deepReady ? createDeepFilterProcessor() : createRNNoiseProcessor();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LocalTrack.setProcessor uses wide generic, but AudioProcessorOptions is guaranteed at runtime with webAudioMix
      await micPub.track.setProcessor(processor as any);
      this.attachedEngine = key;
      log.info("noise suppressor attached", { engine: key });
    } catch (err) {
      log.error("noise suppressor failed to attach", err);
      return;
    }

    // Rebuild once, now that the track is final for this call.
    this.setupAudioPipeline();

    // Warm the cache so the NEXT call gets the strong one, without delaying this one.
    if (wantDeep && !deepReady) void prefetchDeepFilter();
  }


  /** Remove RNNoise processor from the local mic track. Safe to call if none attached. */
  async removeNoiseSuppressor(): Promise<void> {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    if (micPub.track.getProcessor() === undefined) return;
    await micPub.track.stopProcessor();
    this.attachedEngine = null;
    this.setupAudioPipeline();
    log.info("Noise suppressor removed from mic track");
  }

  // --- Pipeline setup/teardown ---

  /** Build or rebuild the audio pipeline on the current mic track. */
  setupAudioPipeline(): void {
    this.teardownAudioPipeline();
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;

    try {
      const mediaTrack = micPub.track.mediaStreamTrack;
      const ctx = new AudioContext({ sampleRate: 48000 });

      const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]));

      // Analyser: VAD reads time-domain data from here (always real audio)
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;

      // GainNode: controls both input volume and VAD gating. Clamp on read too:
      // prefs saved by older builds could hold up to 300, which audibly clips.
      const gainNode = ctx.createGain();
      this.currentInputGain = Math.min(loadPref<number>("inputVolume", 100), 200) / 100;
      gainNode.gain.setValueAtTime(this.currentInputGain, ctx.currentTime);

      const dest = ctx.createMediaStreamDestination();

      // Wire: source → analyser (tap) and source → gain → dest
      source.connect(analyser);
      source.connect(gainNode);
      gainNode.connect(dest);

      this.audioPipelineCtx = ctx;
      this.audioPipelineGain = gainNode;
      this.audioPipelineAnalyser = analyser;
      this.audioPipelineDest = dest;

      // Swap the WebRTC sender to the pipeline output — but ONLY once the AudioContext is
      // actually running. A suspended context (autoplay policy) outputs SILENCE, which made
      // the mic appear dead for the first moments after joining. Until it resumes, LiveKit's
      // NATIVE mic track stays on the sender (audible immediately); we swap in seamlessly on
      // 'running'. resume() usually succeeds because join is a click, but the statechange
      // listener covers the case where it needs a later gesture.
      const adjustedTrack = dest.stream.getAudioTracks()[0];
      const sender = micPub.track.sender;
      const swapIn = (): void => {
        // Bail if the pipeline was torn down / rebuilt in the meantime (stale closure).
        if (adjustedTrack === undefined || !sender || this.audioPipelineDest !== dest) return;
        void sender.replaceTrack(adjustedTrack).catch((err) => {
          log.warn("Failed to replace sender track with pipeline output", err);
        });
      };
      if (ctx.state === "running") {
        swapIn();
      } else {
        const onState = (): void => {
          if (ctx.state === "running") { ctx.removeEventListener("statechange", onState); swapIn(); }
        };
        ctx.addEventListener("statechange", onState);
        void ctx.resume();
      }

      log.info("Audio pipeline created", { inputGain: this.currentInputGain, ctxState: ctx.state });

      // Start VAD polling if sensitivity < 100
      this.startVadPolling();
      // Start the local speaking-ring monitor (independent of VAD/sensitivity).
      this.startSpeakingMonitor();
    } catch (err) {
      log.warn("Failed to set up audio pipeline", err);
    }
  }

  /** Tear down the audio pipeline and restore the original sender track. */
  teardownAudioPipeline(): void {
    this.stopVadPolling();
    this.stopSpeakingMonitor();

    // Restore original mic track on the WebRTC sender
    if (this.room !== null) {
      const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (micPub?.track?.sender !== undefined) {
        const originalTrack = micPub.track.mediaStreamTrack;
        void micPub.track.sender.replaceTrack(originalTrack).catch((err) => log.debug("Failed to replace track during teardown", err));
      }
    }

    if (this.audioPipelineGain !== null) { this.audioPipelineGain.disconnect(); this.audioPipelineGain = null; }
    if (this.audioPipelineAnalyser !== null) { this.audioPipelineAnalyser.disconnect(); this.audioPipelineAnalyser = null; }
    if (this.audioPipelineDest !== null) { this.audioPipelineDest.disconnect(); this.audioPipelineDest = null; }
    if (this.audioPipelineCtx !== null) { void this.audioPipelineCtx.close(); this.audioPipelineCtx = null; }
    this.vadGated = false;
  }

  // --- Local speaking-ring monitor -------------------------------------------
  // Lights the local user's tile/avatar when the mic picks up speech. Computed
  // locally from the pipeline analyser, so it works regardless of the SFU's
  // active-speaker reporting and independent of the VAD transmission gate.
  // setLocalSpeaking is the ONLY writer of the local user's `speaking` flag.
  //
  // Fixed thresholds. Tracking the room's noise floor was tried here and was worse: the
  // floor learned from the speech itself every time the ring dropped mid-sentence, climbed
  // toward it, and then the ring stopped lighting at all. Simple and predictable beats
  // clever and occasionally blind.
  private speakingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSpeakTs = 0;
  private speakDbgPeak = 0;
  private speakDbgTs = 0;

  private startSpeakingMonitor(): void {
    this.stopSpeakingMonitor();
    const analyser = this.audioPipelineAnalyser;
    const ctx = this.audioPipelineCtx;
    if (analyser === null || ctx === null) return;
    const buf = new Float32Array(analyser.fftSize);
    // Low, fixed, and safe to be this low precisely BECAUSE the denoiser runs in front of
    // it: between words that produces true silence, not quiet, so there is nothing left down
    // here to false-trigger on. 0.010 was set for a signal the browser's AGC levelled up;
    // with the filter doing the work instead, ordinary speech sits well under it.
    const SPEAK_ON = 0.0030;
    const SPEAK_OFF = 0.0015;  // hysteresis: easier to stay lit than to light up
    // Pauses inside a sentence are longer than they feel, and the filter makes them silent
    // rather than quiet — at 350ms the ring blinked out mid-sentence.
    const HANGOVER_MS = 700;

    this.speakingTimer = setInterval(() => {
      // The AudioContext can start suspended (autoplay policy) → analyser reads
      // silence. Keep nudging it awake so the monitor actually sees audio.
      if (ctx.state === "suspended") void ctx.resume();

      if (voiceStore.getState().localMuted) {
        this.lastSpeakTs = 0;
        setLocalSpeaking(false);
        return;
      }

      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i] ?? 0; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const currentlyLit = this.lastSpeakTs > 0 && now - this.lastSpeakTs < HANGOVER_MS;

      // Follow the background: creep up while it is quiet, drop straight to a new low.
      const threshold = currentlyLit ? SPEAK_OFF : SPEAK_ON;
      if (rms > threshold) this.lastSpeakTs = now;
      setLocalSpeaking(this.lastSpeakTs > 0 && now - this.lastSpeakTs < HANGOVER_MS);

      // Lightweight diagnostics: log the peak RMS every ~3s so mic-level issues
      // are visible in the console without needing a debugger.
      if (rms > this.speakDbgPeak) this.speakDbgPeak = rms;
      if (now - this.speakDbgTs > 3000) {
        // Back to debug now that the thresholds are settled — speech measures ~0.17 against
        // a 0.003 bar, which is not a margin that needs watching. Raise it to info again if
        // the ring ever misbehaves; that is what it is for.
        log.debug("speaking monitor", { peakRms: Number(this.speakDbgPeak.toFixed(4)), onAt: SPEAK_ON, ctx: ctx.state });
        this.speakDbgPeak = 0;
        this.speakDbgTs = now;
      }
    }, 80);
  }

  private stopSpeakingMonitor(): void {
    if (this.speakingTimer !== null) { clearInterval(this.speakingTimer); this.speakingTimer = null; }
    this.lastSpeakTs = 0;
    setLocalSpeaking(false);
  }

  /** Update the effective gain on the pipeline (inputVolume × vadGate).
   *  The pipeline only exists when unmuted — muting tears it down entirely. */
  updatePipelineGain(): void {
    if (this.audioPipelineGain === null || this.audioPipelineCtx === null) return;
    const effectiveGain = this.vadGated ? 0 : this.currentInputGain;
    this.audioPipelineGain.gain.setTargetAtTime(effectiveGain, this.audioPipelineCtx.currentTime, 0.015);
  }

  private setVadGated(gated: boolean): void {
    this.vadGated = gated;
    this.updatePipelineGain();
  }

  // --- Volume/sensitivity ---

  setInputVolume(volume: number): void {
    // 2× ceiling: higher gains drive the mic signal into digital clipping.
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("inputVolume", clamped);
    this.currentInputGain = clamped / 100;
    this.updatePipelineGain();
  }

  /**
   * Apply voice sensitivity as a client-side VAD gate.
   * Sensitivity 0 = gate everything (threshold impossibly high).
   * Sensitivity 100 = gate nothing (no VAD polling).
   * VAD sets gain to 0 when gated, restores inputVolume when ungated.
   */
  setVoiceSensitivity(sensitivity: number): void {
    const clamped = Math.max(0, Math.min(100, sensitivity));
    savePref("voiceSensitivity", clamped);
    // Restart VAD polling with the new threshold (pipeline stays intact)
    this.stopVadPolling();
    if (clamped >= 100) {
      // Ensure ungated
      if (this.vadGated) { this.vadGated = false; this.updatePipelineGain(); }
    } else {
      this.startVadPolling();
    }
    log.debug("Voice sensitivity updated", { sensitivity: clamped });
  }

  // --- VAD (Voice Activity Detection) ---
  //
  // Primary: AudioWorklet (vad-worklet.js) — runs on audio thread, works when
  //          app is backgrounded, zero main-thread CPU.
  // Fallback: setTimeout polling — used if AudioWorklet fails to load.

  private vadWorkletNode: AudioWorkletNode | null = null;
  /** Latest RMS value from VAD worklet, used for UI indicator. */
  private _lastVadRms = 0;
  private _vadUsingWorklet = false;

  /** Latest RMS value from VAD (for UI indicator bar). */
  get lastVadRms(): number { return this._lastVadRms; }
  /** Whether VAD is using AudioWorklet (true) or setTimeout fallback (false). */
  get vadUsingWorklet(): boolean { return this._vadUsingWorklet; }

  /** Start VAD — tries AudioWorklet first, falls back to setTimeout polling. */
  startVadPolling(): void {
    this.stopVadPolling();
    if (this.audioPipelineCtx === null || this.audioPipelineAnalyser === null) return;

    const sensitivity = loadPref<number>("voiceSensitivity", 95);
    if (sensitivity >= 100) return;

    const threshold = ((100 - sensitivity) / 100) * 0.10;

    // Try AudioWorklet first
    this.audioPipelineCtx.audioWorklet.addModule("/vad-worklet.js").then(() => {
      if (this.audioPipelineCtx === null) return; // Torn down while loading
      this.startVadWorklet(threshold);
    }).catch((err) => {
      log.warn("AudioWorklet unavailable, falling back to setTimeout VAD", err);
      this.startVadFallback(threshold);
    });
  }

  /** Start VAD via AudioWorklet (preferred — runs on audio thread). */
  private startVadWorklet(threshold: number): void {
    if (this.audioPipelineCtx === null) return;

    try {
      const workletNode = new AudioWorkletNode(this.audioPipelineCtx, "vad-processor");

      // Wire: source → analyser → workletNode (workletNode receives audio directly)
      // We connect to the analyser's output so both the analyser and worklet see audio
      if (this.audioPipelineAnalyser !== null) {
        this.audioPipelineAnalyser.connect(workletNode);
      }
      // Don't connect workletNode output to anything — it's analysis-only

      workletNode.port.postMessage({ type: "config", threshold });

      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type === "gate") {
          const gated = event.data.gated as boolean;
          if (gated !== this.vadGated) this.setVadGated(gated);
        } else if (event.data.type === "rms") {
          this._lastVadRms = event.data.value as number;
        }
      };

      this.vadWorkletNode = workletNode;
      this._vadUsingWorklet = true;
      log.info("VAD AudioWorklet started", { threshold });
    } catch (err) {
      log.warn("Failed to create VAD AudioWorkletNode, falling back", err);
      this.startVadFallback(threshold);
    }
  }

  /** Start VAD via setTimeout polling (fallback — works when AudioWorklet unavailable).
   *  setTimeout instead of rAF: rAF pauses when the Tauri window is backgrounded,
   *  which freezes the VAD gate. setTimeout continues firing (throttled ~1Hz when
   *  hidden), still fast enough for VAD gate timing (200ms on, 100ms off). */
  private startVadFallback(threshold: number): void {
    if (this.audioPipelineAnalyser === null) return;

    const analyser = this.audioPipelineAnalyser;
    const dataArray = new Float32Array(analyser.fftSize);
    let silentFrames = 0;
    let speechFrames = 0;
    const GATE_ON_FRAMES = 12;
    const GATE_OFF_FRAMES = 2;
    let startupFrames = 0;
    const STARTUP_GRACE = 30;
    let frameCounter = 0;

    const poll = (): void => {
      if (this.audioPipelineAnalyser === null) return;

      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Send RMS for UI indicator (~50ms interval)
      frameCounter++;
      if (frameCounter >= 3) {
        frameCounter = 0;
        this._lastVadRms = rms;
      }

      if (startupFrames < STARTUP_GRACE) {
        startupFrames++;
        this.vadTimer = setTimeout(poll, 16);
        return;
      }

      if (rms < threshold) {
        speechFrames = 0;
        silentFrames++;
        if (!this.vadGated && silentFrames >= GATE_ON_FRAMES) {
          this.setVadGated(true);
        }
      } else {
        silentFrames = 0;
        speechFrames++;
        if (this.vadGated && speechFrames >= GATE_OFF_FRAMES) {
          this.setVadGated(false);
        }
      }

      this.vadTimer = setTimeout(poll, 16);
    };
    this.vadTimer = setTimeout(poll, 16);
    this._vadUsingWorklet = false;
    log.info("VAD setTimeout fallback started", { threshold });
  }

  /** Stop VAD (both worklet and fallback). Pipeline stays intact. */
  stopVadPolling(): void {
    // Stop setTimeout fallback
    if (this.vadTimer !== null) {
      clearTimeout(this.vadTimer);
      this.vadTimer = null;
    }
    // Stop AudioWorklet
    if (this.vadWorkletNode !== null) {
      this.vadWorkletNode.port.postMessage({ type: "stop" });
      this.vadWorkletNode.disconnect();
      this.vadWorkletNode = null;
    }
    this._vadUsingWorklet = false;
    this._lastVadRms = 0;
    // Ungate if was gated
    if (this.vadGated) {
      this.vadGated = false;
      this.updatePipelineGain();
    }
  }

  /**
   * Re-apply audio processing settings (echo cancellation, noise suppression, AGC)
   * to the live mic track by restarting it with updated constraints.
   */
  async reapplyAudioProcessing(onError?: (message: string) => void): Promise<void> {
    if (this.room === null) {
      log.debug("Skipping audio processing reapply — no active voice session");
      return;
    }
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) {
      log.debug("Skipping audio processing reapply — no mic track");
      return;
    }

    const captureOptions = micCaptureOptions();

    // 1) Browser DSP (echo cancellation / noise suppression / AGC): re-acquire the
    //    mic with the new constraints. These are getUserMedia capture constraints,
    //    so restartTrack is what actually makes them take effect on the live track.
    try {
      await (micPub.track as LocalAudioTrack).restartTrack(captureOptions);
      // Underlying mic track changed → rebuild the gain/VAD graph on top of it.
      this.setupAudioPipeline();
      log.info("Browser audio DSP reapplied via restartTrack", captureOptions);
    } catch (err) {
      log.error("Failed to reapply browser audio DSP", err);
      onError?.("Failed to update microphone settings");
    }

    // 2) RNNoise (Enhanced Noise Suppression): applied INDEPENDENTLY so that a
    //    failure here (e.g. a browser without the required audio APIs) can never
    //    prevent the echo/noise/AGC toggles above from taking effect.
    const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", true);
    try {
      if (enhancedNS) {
        await this.applyNoiseSuppressor();
      } else {
        await this.removeNoiseSuppressor();
      }
    } catch (err) {
      log.error("Failed to apply RNNoise processor", err);
      if (enhancedNS) onError?.("Enhanced noise suppression isn't supported in this browser");
    }
  }
}
