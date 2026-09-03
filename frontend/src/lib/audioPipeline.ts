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
import { nextMakeupGain, MAKEUP_GAIN } from "@lib/makeupGain";
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

export function micCaptureOptions(): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
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
    if (this.sharedCtx !== null && this.sharedCtx.state !== "closed") return;
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
      // The page's context, not one of our own. Falling back to a fresh one only covers the
      // case where nothing primed it — and that one will be suspended wherever it matters.
      const ctx = this.sharedCtx ?? new AudioContext();
      this.sharedCtx ??= ctx;

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

      // The loudness AGC used to provide, moved to where it belongs: after the model. Make-up
      // gain lifts the voice back to the level people expect, and the compressor catches the
      // peaks that lift would otherwise clip. Both sit downstream of the denoiser, so neither
      // can raise the noise floor it measures — which is the whole reason AGC had to go.
      const makeup = ctx.createGain();
      // Unity while AGC is on: it has already set the level, and a fixed lift on top is the
      // same double regulation in slower motion.
      const startGain = loadPref<boolean>("autoGainControl", true) ? 1 : MAKEUP_GAIN;
      makeup.gain.setValueAtTime(startGain, ctx.currentTime);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-24, ctx.currentTime);
      comp.knee.setValueAtTime(30, ctx.currentTime);
      comp.ratio.setValueAtTime(4, ctx.currentTime);
      comp.attack.setValueAtTime(0.003, ctx.currentTime);
      comp.release.setValueAtTime(0.25, ctx.currentTime);

      // Wire: source → analyser (tap) and source → gain → make-up → compressor → dest
      // Order matters, and the first arrangement had it backwards.
      //
      //   source → levelMeter                    raw level, nothing gates it
      //   source → makeup → analyser             the VAD judges NORMALISED audio
      //                   → gainNode → comp → dest
      //
      // The measurement is taken off the SOURCE because gainNode is also the VAD gate: with a
      // quiet microphone the gate stays shut, a meter behind it reads zero, the normaliser
      // learns nothing and never lifts — and the gate cannot open because nothing lifted it.
      // The only way out of that circle was to shout, which is exactly what a guest on Firefox
      // had to do.
      //
      // And the VAD now sits AFTER the make-up gain for the same reason in reverse: a fixed
      // threshold only means the same thing on every machine if what it judges has already
      // been brought to the same loudness.
      source.connect(makeup);
      makeup.connect(analyser);
      makeup.connect(gainNode);
      gainNode.connect(comp);
      comp.connect(dest);

      this.pipelineTrack = mediaTrack;
      // No normaliser here: loudness is settled upstream of the denoiser now — see
      // installPreGain. Two regulators on one signal is what made a guest deafening.
      makeup.gain.setValueAtTime(1, ctx.currentTime);

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
  private startNormaliser(ctx: AudioContext, meter: AnalyserNode, makeup: GainNode): void {
    this.stopNormaliser();
    // Runs alongside AGC now, not instead of it, and that is not the double regulation it was
    // when this sat AFTER the denoiser. There it multiplied an already-lifted signal and drove
    // the output to 0.86 against a target of 0.05. Here it is upstream of the model and its
    // job is different: AGC does the coarse, per-microphone work and lands each browser
    // somewhere different, and this brings those somewheres to one number.
    const buf = new Float32Array(meter.fftSize);
    let gain = MAKEUP_GAIN;
    // What the microphone is actually producing, reported every few seconds. Twice now the
    // right numbers were guessed at instead of read — a floor too high to notice speech, then
    // a ceiling too low to lift it — and each guess cost a round trip through a real call.
    // These two numbers make the next question answerable from a console instead.
    let peak = 0;
    let ticks = 0;
    this.normaliserTimer = setInterval(() => {
      meter.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      if (rms > peak) peak = rms;
      if (++ticks >= 25) {                       // ~3 s
        log.info("microphone level", {
          peakRms: Number(peak.toFixed(5)),
          peakDbfs: Number((20 * Math.log10(peak + 1e-9)).toFixed(1)),
          gain: Number(gain.toFixed(2)),
          sending: Number((peak * gain).toFixed(4)),
        });
        peak = 0;
        ticks = 0;
      }
      const next = nextMakeupGain(gain, rms);
      if (next === gain) return;
      gain = next;
      makeup.gain.setTargetAtTime(gain, ctx.currentTime, 0.15);
    }, 120);
  }

  private preGainDest: MediaStreamAudioDestinationNode | null = null;

  /**
   * Bring the microphone to a common loudness BEFORE the denoiser sees it.
   *
   * This is the difference between browsers, and it cannot be fixed anywhere else. We ask for
   * autoGainControl and each browser honours it differently: Chrome lifts hard, macOS lifts
   * for Safari, Firefox barely lifts at all. The denoiser then runs at 25 dB of suppression,
   * and to it a signal at -70 dBFS is indistinguishable from noise — so on Firefox it deleted
   * the voice while the same call was fine on Chrome. Nothing downstream can undo that: by
   * the time the old make-up gain ran, there was nothing left to amplify.
   *
   * So the lift moves upstream of the model. LiveKit's own replaceTrack is the seam: we build
   * source → meter → gain → destination on the raw capture and hand the result back as the
   * track, then the processor is attached on top of THAT. The browser's AGC still does the
   * coarse, per-microphone work; this removes what it leaves behind.
   *
   * Returns the track to publish, or null when there is nothing to do — the caller then keeps
   * the raw one rather than losing audio over a failed graph.
   */
  installPreGain(raw: MediaStreamTrack): MediaStreamTrack | null {
    const ctx = this.sharedCtx;
    if (ctx === null) {
      log.warn("no shared context — publishing the microphone unnormalised");
      return null;
    }
    try {
      this.teardownPreGain();
      const source = ctx.createMediaStreamSource(new MediaStream([raw]));
      const meter = ctx.createAnalyser();
      meter.fftSize = 1024;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(1, ctx.currentTime);
      const dest = ctx.createMediaStreamDestination();
      source.connect(meter);
      source.connect(gain);
      gain.connect(dest);
      this.preGainDest = dest;
      this.startNormaliser(ctx, meter, gain);
      const out = dest.stream.getAudioTracks()[0];
      if (out === undefined) { this.teardownPreGain(); return null; }
      log.info("pre-model normaliser installed");
      return out;
    } catch (err) {
      log.warn("could not install the pre-model normaliser", err);
      this.teardownPreGain();
      return null;
    }
  }

  private teardownPreGain(): void {
    this.stopNormaliser();
    if (this.preGainDest !== null) { this.preGainDest.disconnect(); this.preGainDest = null; }
  }

  /**
   * Close the page's context. Only when the call is over: while it is up, the room and the
   * denoiser are inside it, and closing it takes their audio with it.
   */
  closeContext(): void {
    if (this.sharedCtx === null) return;
    const ctx = this.sharedCtx;
    this.sharedCtx = null;
    void ctx.close().catch(() => { /* already gone */ });
  }

  private stopNormaliser(): void {
    if (this.normaliserTimer !== null) clearInterval(this.normaliserTimer);
    this.normaliserTimer = null;
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
