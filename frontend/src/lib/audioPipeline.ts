// AudioPipeline — unified audio pipeline: input volume + VAD gating + loudness
//
// Architecture:
//   micTrack → AudioContext source
//       ├──→ AnalyserNode (VAD)
//       └──→ GainNode (inputVolume × vadGate) → make-up gain → compressor
//              → MediaStreamDestination → WebRTC sender
//
// The source is LiveKit's `mediaStreamTrack`, and that is the DENOISER'S OUTPUT whenever a
// processor is attached — the getter returns `processor.processedTrack ?? _mediaStreamTrack`.
// This header used to claim the analyser saw raw audio; it has not since the day a processor
// was first set, and the VAD thresholds here were tuned against denoised signal.
//
// Loudness lives at the END of this chain on purpose. The browser's own AGC would do the same
// job, but it runs BEFORE the denoiser and keeps raising the room's noise floor, which leaves
// the model, the speaking ring and the speech gate all reading a silent room as speech.
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
import { createRNNoiseProcessor, MIN_DENOISE_RATE, micInputRate, handBackToBrowser } from "@lib/noise-suppression";
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
/**
 * RMS level at which the transmission gate opens, for a sensitivity of 0-100.
 *
 * Exported because the settings meter draws the same line, and the two used to compute it
 * from different constants — 0.10 here, 0.15 there. The meter therefore drew the threshold
 * half again as high as the gate actually used, so a user could set the slider until road
 * noise sat below the line, watch it stay dim, and still transmit it.
 */
export function vadThreshold(sensitivity: number): number {
  return ((100 - sensitivity) / 100) * 0.10;
}

export function micCaptureOptions(): {
  echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean; voiceIsolation: boolean;
} {
  const enhanced = loadPref<boolean>("enhancedNoiseSuppression", true);
  return {
    // Echo cancellation stays: it runs before everything else, which is where it belongs,
    // and nothing downstream can undo a speaker bleeding into the microphone.
    echoCancellation: loadPref("echoCancellation", true),
    // Two suppressors in series over-suppress and leave the hum anyway — ours is the only
    // one on the signal whenever it is running.
    noiseSuppression: enhanced ? false : loadPref("noiseSuppression", true),
    // AGC stays ON, and this is the third pass over that decision — the first two were wrong
    // in opposite directions, so the reason is worth writing down properly.
    //
    // The objection to it is real: AGC runs BEFORE the denoiser and keeps lifting the room's
    // noise floor, giving the model a moving reference. So it was turned off, with make-up
    // gain added AFTER the model to restore the loudness. That works on Chrome and on Safari
    // and fails completely on Firefox, for a reason neither of those can show you: they add
    // gain of their own regardless, Firefox honours the request exactly and hands over the
    // raw signal — and a raw laptop microphone at about -70 dBFS is, to a denoiser set to
    // 25 dB of suppression, indistinguishable from noise. It deleted the voice. Measured on a
    // guest's Mac: peaks of -85 dBFS after the model where Chrome saw -16 before it.
    //
    // Make-up gain cannot rescue that: it sits downstream of the model and there is nothing
    // left to amplify. The lift has to happen BEFORE the model or not at all, and the browser
    // is the only thing positioned to do it per-microphone. So AGC does the coarse work and
    // the normaliser trims what is left.
    autoGainControl: loadPref("autoGainControl", true),
    // In LiveKit's own capture defaults, and free where it exists: a platform-level voice
    // isolation pass that runs before anything we can reach. Ignored by browsers that do not
    // have it, so there is nothing to feature-detect.
    voiceIsolation: true,
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
  private normaliserTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * THE audio context of this page — one, created inside a click, shared by everyone.
   *
   * There used to be three: LiveKit made its own for the room, the denoiser got whatever
   * LiveKit handed it, and the pipeline made a third. Each woke separately, and in Firefox
   * and Safari a context created outside a gesture does not wake at all — so the denoiser
   * could sit in a suspended one and publish silence while the other two were fine. LiveKit
   * even documents tolerating that: acquireAudioContext races resume() against a 200 ms
   * timer and carries on with a suspended context, warning only.
   *
   * So the page creates one from the click and hands it to the Room as
   * `webAudioMix: { audioContext }`, which is what LiveKit then passes to the processor. One
   * context, one wake, one state to reason about.
   */
  private sharedCtx: AudioContext | null = null;

  /** The shared context, for handing to `new Room({ webAudioMix: { audioContext } })`. */
  get context(): AudioContext | null { return this.sharedCtx; }
  /** The mic track the current pipeline was built on, so a repeat build can be recognised. */
  private pipelineTrack: MediaStreamTrack | null = null;
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

    // Log what the microphone actually IS before deciding anything with it. Nothing in this
    // client ever read getSettings(), so a headset running at 16 kHz looked exactly like a
    // desk microphone running at 48 — and the difference is the whole problem.
    const mediaTrack = micPub.track.mediaStreamTrack;
    log.info("microphone input", mediaTrack.getSettings());

    const rate = micInputRate(mediaTrack);
    if (rate !== null && rate < MIN_DENOISE_RATE) {
      if (micPub.track.getProcessor() !== undefined) {
        await micPub.track.stopProcessor();
        this.attachedEngine = null;
      }
      log.warn("narrowband microphone — our models cannot work in this band", { rate });
      await handBackToBrowser(mediaTrack, `input at ${rate} Hz`);
      this.setupAudioPipeline();
      return;
    }

    const wantDeep = loadPref<string>("nsEngine", "rnnoise") === "deepfilter" && supportsDeepFilter();
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
      // micCaptureOptions() has ALREADY turned the browser's suppressor and AGC off, on the
      // promise that ours would own the signal. It does not, so give them back: no filter at
      // all, at half the loudness, is worse than the browser's — which is exactly what a
      // failed attach used to leave behind.
      log.error("noise suppressor failed to attach", err);
      await handBackToBrowser(mediaTrack, "attach failed");
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

  /**
   * Create the AudioContext NOW, from inside a click, so the pipeline can be built later.
   *
   * This must be called synchronously from the handler that turns the microphone on — before
   * any await. Firefox and Safari only let a context start (or resume) while a gesture is
   * being handled, and by the time setMicrophoneEnabled() has resolved we are several promises
   * past it. A context created there stays suspended, runs no graph, and the destination node
   * we publish carries silence — which is how a guest came to be inaudible on a live call
   * while everyone on Chrome was fine.
   *
   * Cheap and idempotent: a second call while one is already primed does nothing.
   */
  primeContext(): void {
    const existing = this.sharedCtx;
    if (existing !== null && existing.state !== "closed") {
      // Existing is not the same as running. A context built outside a gesture starts
      // suspended, and one the browser parked when the tab went to the background stays that
      // way until something wakes it. Every caller of this is a click, and a click is the only
      // thing that can — returning early here left remote audio mixing into a stopped graph.
      if (existing.state === "suspended") {
        void existing.resume()
          .then(() => log.info("audio context resumed from the gesture", { state: existing.state }))
          .catch((err) => log.warn("audio context resume rejected", err));
      }
      return;
    }
    try {
      // No forced sampleRate. Asking for 48000 on a Mac whose device runs at 44100 is a
      // request Chrome and Safari satisfy by resampling and Firefox does not: the context is
      // handed back and stays SUSPENDED, the graph never runs, and the destination node we
      // publish carries nothing. That is what a guest's console showed — primed from the
      // gesture, still suspended, and a level meter reading -85 dBFS off a stopped graph.
      // Everything downstream already copes with whatever rate the hardware uses; the VAD
      // worklet derives its hold times from sampleRate and is checked at 44100 too.
      const ctx = new AudioContext();
      this.sharedCtx = ctx;
      // Inside the gesture, so this is the one moment the browser will honour it.
      void ctx.resume()
        .then(() => log.info("audio context resumed", { state: ctx.state, rate: ctx.sampleRate }))
        .catch((err) => log.warn("audio context resume rejected", err));
      log.info("audio context primed from the gesture", { state: ctx.state, rate: ctx.sampleRate });
    } catch (err) {
      log.warn("could not prime the audio context", err);
      this.sharedCtx = null;
    }
  }

  /** Build or rebuild the audio pipeline on the current mic track. */
  setupAudioPipeline(): void {
    if (this.room === null) { this.teardownAudioPipeline(); return; }
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) { this.teardownAudioPipeline(); return; }

    // Already built on this very track — leave it alone. Joining a channel calls this twice
    // (the connect path and the state-restore path both do), and rebuilding threw away the
    // context primed from the click and made a fresh one outside any gesture: exactly the
    // suspended, silent context the priming exists to avoid. Chrome hid it; Firefox would not.
    //
    // BEFORE the teardown, which is where this check has to live: teardown clears the very
    // fields it reads, so a guard placed after it can never fire. It was, and it did not.
    if (this.audioPipelineCtx !== null && this.pipelineTrack === micPub.track.mediaStreamTrack) {
      log.debug("audio pipeline already built on this track");
      return;
    }

    this.teardownAudioPipeline();

    try {
      const mediaTrack = micPub.track.mediaStreamTrack;
      // The primed one when a click gave us one, which is the whole point of primeContext.
      // The page's context, not one of our own.
      const ctx = this.sharedCtx ?? new AudioContext();
      this.sharedCtx ??= ctx;

      const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]));

      // A TAP, not a stage. It is connected to nothing downstream, so it reads the signal
      // without standing in it: the VAD meter and the speaking ring both live off this, and
      // neither can affect a single sample anyone hears.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);

      // WHY THERE IS NOTHING ELSE HERE.
      //
      // The browser already runs the WebRTC audio pipeline on this track, in a fixed order:
      // high-pass → echo cancellation → noise suppression (ours instead) → AGC. AGC is the
      // LAST stage by design, and everything we used to hang off this graph — make-up gain, a
      // 4:1 compressor, a VAD gate — was a second regulator sitting after it, four steps too
      // late. That is the whole explanation for "Chrome is deafening, Firefox is fine": Chrome
      // levels aggressively, Firefox gently, and our second stage did not flatten that
      // difference, it multiplied it. LiveKit's own capture defaults leave the browser's AGC
      // on and add nothing; Jitsi puts RNNoise in a worklet and stops there. So do we now.
      //
      // Loudness differences BETWEEN people belong to the listener — per-participant gain on
      // the receiving side, where nobody's signal is rewritten. See AudioElements.
      //
      // The one exception is the input-volume slider: a fixed multiplier the person chose
      // themselves, not an automatic regulator racing the AGC. At 100% it does not exist at
      // all, and then we publish the microphone track untouched — no graph in the sending
      // path means no way for a suspended context to turn a live microphone into silence.
      let dest: MediaStreamAudioDestinationNode | null = null;
      let gainNode: GainNode | null = null;
      if (this.currentInputGain !== 1) {
        gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(this.currentInputGain, ctx.currentTime);
        dest = ctx.createMediaStreamDestination();
        source.connect(gainNode);
        gainNode.connect(dest);
      }

      this.pipelineTrack = mediaTrack;
      this.audioPipelineCtx = ctx;
      this.audioPipelineGain = gainNode;
      this.audioPipelineAnalyser = analyser;
      this.audioPipelineDest = dest;

      // Only when the slider is off unity. Swap once the context is actually running: a
      // suspended one outputs SILENCE, and until it resumes LiveKit's native track stays on
      // the sender, audible from the first second.
      if (dest !== null) {
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
      }

      log.info("Audio pipeline created", { inputGain: this.currentInputGain, inPath: dest !== null, ctxState: ctx.state });

      // Start VAD polling if sensitivity < 100
      this.startVadPolling();
      // Start the local speaking-ring monitor (independent of VAD/sensitivity).
      this.startSpeakingMonitor();
    } catch (err) {
      log.warn("Failed to set up audio pipeline", err);
    }
  }

  /** Tear down the audio pipeline and restore the original sender track. */
  /**
   * Drive the make-up gain from what the microphone is actually producing.
   *
   * The gain used to be the constant 2, which only ever worked where the browser had already
   * lifted the signal — Chrome does, macOS does it for Safari, Firefox does not because we
   * asked it not to. That is why one guest was inaudible while the same call sounded fine to
   * everyone else. A measurement serves every microphone; a constant serves one.
   *
   * Every 120 ms rather than every frame: loudness is a property of a phrase, and adapting
   * faster than that is what pumping sounds like. setTargetAtTime rather than a step, so the
   * change is a slide and never a click.
   */
  closeContext(): void {
    if (this.sharedCtx === null) return;
    const ctx = this.sharedCtx;
    this.sharedCtx = null;
    void ctx.close().catch(() => { /* already gone */ });
  }


  teardownAudioPipeline(): void {
    this.pipelineTrack = null;
    // The normaliser is NOT stopped here. It belongs to the pre-model stage, which lives
    // upstream of everything this function takes down — and stopping it here silently undid
    // the levelling every time the post-model pipeline was built, which is once per join.
    // teardownPreGain owns it.
    // The context deliberately survives: the room and the denoiser are still using it. It is
    // closed only when the page leaves the call — see closeContext.
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
    // Drop the REFERENCE, never close it. It is the page's context — the room mixes every
    // remote voice through it (webAudioMix) and the denoiser runs in it. Closing it here is
    // what made muting your own microphone take everyone else's audio with it: mute tears the
    // pipeline down, and the comment three lines up has always said the context survives while
    // the code right here closed it.
    this.audioPipelineCtx = null;
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
    this.audioPipelineGain.gain.setTargetAtTime(this.currentInputGain, this.audioPipelineCtx.currentTime, 0.015);
  }

  /** Kept as a READING, not an action: the VAD says whether it hears speech, and the UI shows
   *  it. It no longer touches the audio — see the note in setupAudioPipeline. */
  private setVadGated(gated: boolean): void {
    this.vadGated = gated;
  }

  // --- Volume/sensitivity ---

  setInputVolume(volume: number): void {
    // 2× ceiling: higher gains drive the mic signal into digital clipping.
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("inputVolume", clamped);
    const wasInPath = this.currentInputGain !== 1;
    this.currentInputGain = clamped / 100;
    // Crossing unity changes whether there is a graph in the sending path at all, so the
    // pipeline has to be rebuilt rather than nudged.
    if (wasInPath !== (this.currentInputGain !== 1)) this.setupAudioPipeline();
    else this.updatePipelineGain();
  }

  /**
   * The line above which the meter calls it speech.
   *
   * It used to be a transmission gate — silence below the line never left the machine — and
   * that is not what conferencing clients do: the denoiser removes noise, the SFU decides who
   * is speaking from the level in the packet header, and nothing on the send path is allowed
   * to chop a quiet word. Somebody with an old low value saved was getting exactly that, and
   * we heard it as "his audio is ragged". Now it only moves the indicator.
   */
  setVoiceSensitivity(sensitivity: number): void {
    const clamped = Math.max(0, Math.min(100, sensitivity));
    savePref("voiceSensitivity", clamped);
    this.stopVadPolling();
    if (clamped < 100) this.startVadPolling();
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

  /** One reading of what we are actually publishing, off the analyser tap. For the voice
   *  report: measuring beats asking someone whether it "sounds loud". */
  readPublishedRms(): number | null {
    const an = this.audioPipelineAnalyser;
    if (an === null) return null;
    const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }
  /** Whether VAD is using AudioWorklet (true) or setTimeout fallback (false). */
  get vadUsingWorklet(): boolean { return this._vadUsingWorklet; }

  /** Start VAD — tries AudioWorklet first, falls back to setTimeout polling. */
  startVadPolling(): void {
    this.stopVadPolling();
    if (this.audioPipelineCtx === null || this.audioPipelineAnalyser === null) return;

    // Default 98 — a line low enough that speech can never fall under it. See the note in
    // VoiceTab for why neither 95 nor 100 is the right place for it.
    const sensitivity = loadPref<number>("voiceSensitivity", 98);
    if (sensitivity >= 100) return;

    const threshold = vadThreshold(sensitivity);

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

      // Hold times in MILLISECONDS. They were frame counts, and the worklet's frame is a
      // 128-sample render quantum — six times shorter than the setTimeout tick the numbers
      // were written for — so every hold ran six times too short.
      workletNode.port.postMessage({ type: "config", threshold, gateOnMs: 200, gateOffMs: 32 });

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

      // This path ticks every 16ms, so ITS frame counts were always the intended 192ms /
      // 32ms — it is the worklet that ran six times too fast. Left exactly as it was.
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
