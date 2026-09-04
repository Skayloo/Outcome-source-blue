// =============================================================================
// Noise Suppression — RNNoise ML-based noise removal as a LiveKit TrackProcessor
//
// Implements LiveKit's TrackProcessor<Track.Kind.Audio> interface so it
// integrates with setProcessor() / stopProcessor() lifecycle, device switching,
// and mid-call toggling automatically.
//
// RNNoise processes 480-sample frames at 48kHz (10ms).
// Uses AudioWorklet (modern, runs on audio thread) with ScriptProcessorNode
// fallback (deprecated but widely supported).
// =============================================================================

import { createRNNWasmModule } from "@jitsi/rnnoise-wasm";
import { Track, type TrackProcessor, type AudioProcessorOptions } from "livekit-client";
import { createLogger } from "@lib/logger";

const log = createLogger("noise-suppression");

const RNNOISE_FRAME_SIZE = 480;
const SCRIPT_PROCESSOR_BUFFER = 4096;

// ---------------------------------------------------------------------------
// Shared WASM module cache
// ---------------------------------------------------------------------------

interface RNNoiseModule {
  _rnnoise_create: () => number;
  _rnnoise_destroy: (state: number) => void;
  _rnnoise_process_frame: (state: number, out: number, inp: number) => number;
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
  ready: Promise<unknown>;
}

let cachedModule: RNNoiseModule | null = null;

async function loadRNNoise(): Promise<RNNoiseModule> {
  if (cachedModule !== null) return cachedModule;
  const startMs = performance.now();
  const mod = (createRNNWasmModule as (opts: Record<string, unknown>) => unknown)({
    locateFile: (file: string) => {
      if (file.endsWith(".wasm")) return "/rnnoise.wasm";
      return file;
    },
  }) as RNNoiseModule;
  await mod.ready;
  cachedModule = mod;
  log.info("RNNoise WASM loaded", { durationMs: Math.round(performance.now() - startMs) });
  return mod;
}

/** Check if AudioWorklet is available in this browser context. */
function supportsAudioWorklet(): boolean {
  try {
    return typeof AudioWorkletNode !== "undefined"
      && typeof AudioContext !== "undefined"
      && "audioWorklet" in AudioContext.prototype;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal processing pipeline — shared by both init strategies
// ---------------------------------------------------------------------------

interface ProcessingPipeline {
  readonly processedTrack: MediaStreamTrack;
  destroy(): void;
}

/** AudioWorklet-based pipeline (preferred, runs on audio thread). */
/**
 * Wake the AudioContext before anything is wired into it.
 *
 * A suspended context runs no graph, and a MediaStreamAudioDestinationNode hanging off one
 * emits silence — not an error, not a gap, just a track that carries nothing. Publishing that
 * is exactly what "my mic does not work for the first few seconds of a call" looks like from
 * the other side: the context wakes on the next user gesture and the voice arrives late.
 *
 * Browsers hand out suspended contexts by default, so this has to be checked every time and
 * not assumed from how the context was made.
 */
export async function ensureRunning(ctx: AudioContext): Promise<void> {
  // Through locals, not ctx.state directly: comparing the property narrows it for the rest of
  // the function, and the compiler then calls the check after resume() impossible.
  const before: AudioContextState = ctx.state;
  if (before === "running") return;
  log.info("AudioContext not running — resuming before wiring the graph", { state: before });
  // Raced, never plainly awaited. In Firefox and Safari resume() outside a user gesture does
  // not reject — it simply never settles, and this function is awaited from inside the
  // processor's init(), which LiveKit awaits in turn. A promise that never settles there stops
  // the whole chain: no processor, no pipeline, no make-up gain and no speaking indicator,
  // which is exactly what it did. Waking the context is best effort; blocking on it is not.
  try {
    await Promise.race([
      ctx.resume(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
  } catch (err) {
    log.warn("AudioContext resume failed", err);
  }
  const after: AudioContextState = ctx.state;
  if (after === "running") return;

  // Still asleep. Chrome resumes on request; Firefox and Safari only inside a gesture, and by
  // the time this runs we are several promises past the click that started it. Waiting for the
  // NEXT one is the difference between a guest who is silent until they happen to click
  // something and a guest who is silent for a moment.
  log.warn("AudioContext stayed suspended — waking it on the next user gesture", { state: after });
  const events = ["pointerdown", "keydown", "touchstart"] as const;
  const wake = (): void => {
    void ctx.resume().catch(() => { /* nothing else to try */ });
    for (const e of events) document.removeEventListener(e, wake);
  };
  for (const e of events) document.addEventListener(e, wake, { once: false, passive: true });
}

async function createWorkletPipeline(
  inputTrack: MediaStreamTrack,
  audioContext: AudioContext,
): Promise<ProcessingPipeline> {
  await ensureRunning(audioContext);
  // The model travels INSIDE the worklet now (see scripts/build-rnnoise-worklet.mjs). Fetching
  // /rnnoise.wasm and posting the bytes across was the old shape, and it never worked: that
  // build is closure-minified, its exports are named d/e/f/g, and the worklet's check for
  // `rnnoise_create` failed on every call — silently, into the main-thread fallback.
  await audioContext.audioWorklet.addModule("/rnnoise-worklet.js");

  const source = audioContext.createMediaStreamSource(new MediaStream([inputTrack]));
  const dest = audioContext.createMediaStreamDestination();
  const workletNode = new AudioWorkletNode(audioContext, "rnnoise-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  const initPromise = new Promise<void>((resolve, reject) => {
    workletNode.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === "ready") resolve();
      else if (event.data.type === "error") reject(new Error(event.data.message));
    };
  });
  workletNode.port.postMessage({ type: "init" });
  await initPromise;

  source.connect(workletNode);
  workletNode.connect(dest);

  log.info("RNNoise AudioWorklet processing active");

  return {
    processedTrack: dest.stream.getAudioTracks()[0]!,
    destroy() {
      workletNode.port.postMessage({ type: "destroy" });
      workletNode.disconnect();
      source.disconnect();
      dest.disconnect();
      log.info("RNNoise AudioWorklet pipeline destroyed");
    },
  };
}

/** ScriptProcessorNode-based pipeline (fallback). */
async function createScriptProcessorPipeline(
  inputTrack: MediaStreamTrack,
  audioContext: AudioContext,
): Promise<ProcessingPipeline> {
  await ensureRunning(audioContext);
  const wasmModule = await loadRNNoise();
  const rnnoiseState = wasmModule._rnnoise_create();
  const inputPtr = wasmModule._malloc(RNNOISE_FRAME_SIZE * 4);
  const outputPtr = wasmModule._malloc(RNNOISE_FRAME_SIZE * 4);

  const inputRing = new Float32Array(RNNOISE_FRAME_SIZE);
  let inputRingOffset = 0;

  const OUT_RING_CAPACITY = 50;
  const outRing: Float32Array[] = new Array(OUT_RING_CAPACITY);
  let outWriteIdx = 0;
  let outReadIdx = 0;
  let outCount = 0;
  let outSampleOffset = 0;

  function processFrame(): void {
    const inOff = inputPtr / 4;
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      wasmModule.HEAPF32[inOff + i] = (inputRing[i] ?? 0) * 32768;
    }
    wasmModule._rnnoise_process_frame(rnnoiseState, outputPtr, inputPtr);
    const outOff = outputPtr / 4;
    const result = new Float32Array(RNNOISE_FRAME_SIZE);
    for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
      result[i] = (wasmModule.HEAPF32[outOff + i] ?? 0) / 32768;
    }
    if (outCount >= OUT_RING_CAPACITY) {
      outReadIdx = (outReadIdx + 1) % OUT_RING_CAPACITY;
      outCount--;
      outSampleOffset = 0;
    }
    outRing[outWriteIdx] = result;
    outWriteIdx = (outWriteIdx + 1) % OUT_RING_CAPACITY;
    outCount++;
  }

  const source = audioContext.createMediaStreamSource(new MediaStream([inputTrack]));
  const dest = audioContext.createMediaStreamDestination();
  const processorNode = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);

  processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
    const inData = event.inputBuffer.getChannelData(0);
    const outData = event.outputBuffer.getChannelData(0);

    let inIdx = 0;
    while (inIdx < inData.length) {
      const needed = RNNOISE_FRAME_SIZE - inputRingOffset;
      const toCopy = Math.min(needed, inData.length - inIdx);
      inputRing.set(inData.subarray(inIdx, inIdx + toCopy), inputRingOffset);
      inputRingOffset += toCopy;
      inIdx += toCopy;
      if (inputRingOffset >= RNNOISE_FRAME_SIZE) {
        processFrame();
        inputRingOffset = 0;
      }
    }

    let outIdx = 0;
    while (outIdx < outData.length && outCount > 0) {
      const chunk = outRing[outReadIdx]!;
      const available = chunk.length - outSampleOffset;
      const toWrite = Math.min(available, outData.length - outIdx);
      outData.set(chunk.subarray(outSampleOffset, outSampleOffset + toWrite), outIdx);
      outIdx += toWrite;
      outSampleOffset += toWrite;
      if (outSampleOffset >= chunk.length) {
        outReadIdx = (outReadIdx + 1) % OUT_RING_CAPACITY;
        outCount--;
        outSampleOffset = 0;
      }
    }
    if (outIdx < outData.length) {
      outData.fill(0, outIdx);
    }
  };

  source.connect(processorNode);
  processorNode.connect(dest);

  log.info("RNNoise ScriptProcessor processing active (fallback)");

  return {
    processedTrack: dest.stream.getAudioTracks()[0]!,
    destroy() {
      processorNode.onaudioprocess = null;
      processorNode.disconnect();
      source.disconnect();
      dest.disconnect();
      wasmModule._rnnoise_destroy(rnnoiseState);
      wasmModule._free(inputPtr);
      wasmModule._free(outputPtr);
      log.info("RNNoise ScriptProcessor pipeline destroyed");
    },
  };
}

// ---------------------------------------------------------------------------
// LiveKit TrackProcessor implementation
// ---------------------------------------------------------------------------

/**
 * Creates an RNNoise TrackProcessor compatible with LiveKit's
 * LocalAudioTrack.setProcessor() API.
 *
 * Usage:
 *   const processor = createRNNoiseProcessor();
 *   await localAudioTrack.setProcessor(processor);
 *   // Later:
 *   await localAudioTrack.stopProcessor();
 */
/**
 * Below this, our denoisers do more harm than good.
 *
 * Both are 48 kHz designs — RNNoise processes 480-sample frames at 48 kHz, DeepFilterNet is
 * configured for it, and the pipeline's AudioContext is pinned there. A Bluetooth headset
 * leaves A2DP the moment its microphone opens and delivers the hands-free profile instead:
 * 8 or 16 kHz, mono. The browser resamples that up to satisfy our context, so everything
 * above the original Nyquist is interpolation — invented content. A model trained on real
 * wideband speech reads that invented half as structure and acts on it, and the speech gate
 * measures its floor off the same signal. That is what "everyone sounds like they are
 * quacking" is, and no amount of tuning the depth fixes it, because the band it is working
 * in was never there.
 *
 * The browser's own suppressor is built for whatever the device actually gives, so on
 * narrowband input it is the better of the two. Hand it back.
 */
export const MIN_DENOISE_RATE = 32000;

/** The microphone's real sample rate, or null when the browser will not say. */
export function micInputRate(track: MediaStreamTrack): number | null {
  const rate = track.getSettings().sampleRate;
  return typeof rate === "number" && rate > 0 ? rate : null;
}

/**
 * Give the microphone back to the browser's suppressor and AGC.
 *
 * micCaptureOptions() turns both off on the promise that ours owns the signal. Whenever that
 * promise is not kept — a failed attach, or input our models cannot work in — it has to be
 * undone, or the call is left with no suppression at all and half the loudness.
 */
export async function handBackToBrowser(track: MediaStreamTrack, why: string): Promise<void> {
  try {
    await track.applyConstraints({ noiseSuppression: true, autoGainControl: true });
    log.info("browser noise suppression back on", { why });
  } catch (err) {
    log.warn("browser noise suppression could not be turned back on", { why, err });
  }
}

export function createRNNoiseProcessor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let pipeline: ProcessingPipeline | null = null;

  return {
    name: "rnnoise",

    async init(opts: AudioProcessorOptions): Promise<void> {
      log.debug("RNNoise processor init", { audioWorkletSupported: supportsAudioWorklet() });
      const ctx = opts.audioContext;

      if (supportsAudioWorklet()) {
        try {
          pipeline = await createWorkletPipeline(opts.track, ctx);
          return;
        } catch (err) {
          log.warn("AudioWorklet failed, falling back to ScriptProcessorNode", err);
        }
      }

      pipeline = await createScriptProcessorPipeline(opts.track, ctx);
    },

    async restart(opts: AudioProcessorOptions): Promise<void> {
      log.debug("RNNoise processor restart");
      if (pipeline !== null) {
        pipeline.destroy();
        pipeline = null;
      }
      await this.init(opts);
    },

    async destroy(): Promise<void> {
      if (pipeline !== null) {
        pipeline.destroy();
        pipeline = null;
      }
      log.info("RNNoise processor destroyed");
    },

    get processedTrack(): MediaStreamTrack | undefined {
      return pipeline?.processedTrack;
    },
  };
}
