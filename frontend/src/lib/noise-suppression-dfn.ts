// =============================================================================
// Noise Suppression — DeepFilterNet 3
//
// RNNoise is a 2017 model: a tiny recurrent net over 22 Bark bands. It handles a
// steady hum when nothing else is in its way, and gives up on anything that moves —
// a keyboard, a dog, someone else talking. DeepFilterNet 3 is full-band 48 kHz and
// runs in real time on one core, and it is the reason a laptop fan stops being
// audible instead of merely quieter.
//
// The price is size: 8 MB of model plus a 16 MB WebAssembly build, against 112 KB
// for RNNoise. Almost all of that is code, not debug symbols, so there is nothing
// to strip — it is ONNX Runtime compiled to wasm. Hence the loading rule below.
//
// The assets are served from OUR origin, not the package's default CDN. Three
// reasons, in order of how much they would hurt: a third party could swap the
// binary that runs inside our page; every user would announce each call they join
// to someone else's server; and a foreign CDN is exactly what gets blocked for the
// half of our users sitting behind a VPN, which would take voice down with it.
// =============================================================================

import { DeepFilterNoiseFilter } from "deepfilternet3-noise-filter";
import type { Track, TrackProcessor, AudioProcessorOptions } from "livekit-client";
import { createLogger } from "@lib/logger";
import { loadPref, savePref } from "@lib/preferences";
import { ensureRunning } from "@lib/noise-suppression";

const log = createLogger("noise-suppression-dfn");

/** Where the self-hosted model and wasm live (see public/dfn/). */
const ASSET_BASE = "/dfn";

/**
 * How deep the model cuts, on its own 0–100 scale.
 *
 * 20 for everyone, members and guests alike. Higher is not better: the model takes the quiet
 * ends of words along with the noise, and the speaker hears themselves perfectly while
 * everyone else hears them clipped. 40 was the earlier default and it was still eating
 * speech; a fan and a street are gone at 20 too, and the slider is there for rooms that
 * genuinely need more.
 */
const DEFAULT_SUPPRESSION = 25;

/**
 * Put everyone on the new default once, even if they already had a value.
 *
 * Lowering the constant alone reaches nobody who has ever opened the voice settings — their
 * stored 40 keeps winning, which is exactly the number we are trying to get rid of. The flag
 * makes this a one-time reset rather than a setting that refuses to be changed: turn it up
 * afterwards and it stays up.
 */
// Bumped with the number itself: the flag is what makes the reset happen once, so leaving it
// alone would hand 25 only to people who have never opened voice settings — everyone else
// keeps whatever they stored, which is the case this mechanism exists for.
const RESET_FLAG = "nsStrengthForced25";

function applyForcedDefaultOnce(): void {
  if (loadPref<boolean>(RESET_FLAG, false)) return;
  savePref("nsStrength", DEFAULT_SUPPRESSION);
  savePref(RESET_FLAG, true);
  log.info("suppression depth reset to the new default", { level: DEFAULT_SUPPRESSION });
}

export function suppressionLevel(): number {
  applyForcedDefaultOnce();
  const v = loadPref<number>("nsStrength", DEFAULT_SUPPRESSION);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : DEFAULT_SUPPRESSION;
}

/**
 * Is DeepFilterNet usable here? It needs AudioWorklet and WebAssembly, and the
 * package refuses to construct without them.
 */
export function supportsDeepFilter(): boolean {
  try {
    return typeof AudioWorkletNode !== "undefined"
      && typeof WebAssembly !== "undefined"
      && typeof AudioContext !== "undefined"
      && "audioWorklet" in AudioContext.prototype;
  } catch {
    return false;
  }
}

/**
 * Warm the browser cache so the first call does not wait on 24 MB.
 *
 * Fetched with low priority and thrown away — the point is the HTTP cache entry,
 * not the bytes. Safe to call more than once; the second call is a cache hit.
 * Failure is silent by design: this is an optimisation, and the processor falls
 * back to RNNoise on its own if the assets never arrive.
 */
/**
 * Has this browser already pulled the model down?
 *
 * Remembered rather than probed. Asking the HTTP cache directly (`only-if-cached`) works,
 * but a miss is a rejected request, and Chrome prints it as a red ERR_CACHE_MISS in the
 * console of every first-time call — an error that is not one. A flag set once the prefetch
 * has actually finished answers the same question silently.
 *
 * If the cache is evicted while the flag survives, the worst case is that the model is
 * fetched again during attach, which is the situation we were in anyway.
 */
const WARMED_KEY = "dfnWarmed";

export function deepFilterWarmed(): boolean {
  return supportsDeepFilter() && loadPref<boolean>(WARMED_KEY, false);
}

/** In-flight prefetch, so app start and a call joining cannot pull 12 MB twice over. */
let warming: Promise<void> | null = null;

export function prefetchDeepFilter(): Promise<void> {
  warming ??= runPrefetch().finally(() => { warming = null; });
  return warming;
}

async function runPrefetch(): Promise<void> {
  if (!supportsDeepFilter()) return;
  const files = [`${ASSET_BASE}/v3/pkg/df_bg.wasm`, `${ASSET_BASE}/v3/models/DeepFilterNet3_onnx.tar.gz`];
  const landed = await Promise.all(files.map(async (url) => {
    try {
      // The BODY has to be consumed, not just the response awaited: a fetch whose body is
      // never read gets its download cancelled and leaves nothing in the HTTP cache, so the
      // package then fetched all 12 MB a second time. Read it and drop it.
      const res = await fetch(url, { cache: "force-cache", priority: "low" } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.arrayBuffer();
      return true;
    } catch (err) {
      log.debug("DeepFilterNet prefetch skipped", { url, err });
      return false;
    }
  }));

  // Only claim the model is warm when it actually IS. This flag used to be set unconditionally,
  // even when both downloads had failed — and it is what the next call reads to decide whether
  // to run DeepFilterNet. A false "warm" therefore chose a model that was not in the cache, the
  // attach failed, and the caller had already turned the browser's own suppressor off to make
  // room for ours. The result was no suppression at all, stored in localStorage, permanent.
  if (!landed.every(Boolean)) {
    log.warn("DeepFilterNet assets did not land — staying on RNNoise until they do");
    return;
  }
  savePref(WARMED_KEY, true);
  log.info("DeepFilterNet assets warmed");
}

// ── The speech gate ────────────────────────────────────────────────────────────────────
//
// DeepFilterNet's own tooling protects speech with processing THRESHOLDS: quiet passages go
// through the model, loud ones bypass it, and the attenuation limit can then sit at 70–100 dB
// without touching a word. Our wasm binding exposes exactly one control — `df_set_atten_lim`
// — so those thresholds are not available to us.
//
// This is the same idea built from the one knob we do have. While someone is speaking the
// limit drops to a few dB and the model can barely alter them; in the gaps it returns to the
// configured depth and the fan disappears. Noise under speech is masked by the speech itself,
// which is why every implementation of this trade makes the same one.

/** What the model may cut while speech is present. Low enough to be inaudible on a voice. */
/**
 * What the model may cut while the gate is open.
 *
 * Six was chosen to keep the model off the words, and it does — but the gate opens on LEVEL,
 * not on speech, so a keyboard click opens it too, and then six decibels is all the filter is
 * allowed to do to the click, to the room under it, and to everything else for the next
 * HOLD_MS. On the guest page, which has no VAD gate and no browser suppression of its own,
 * six is the whole of what a guest gets.
 *
 * Overridable at runtime so a value can be tried on real ears without a redeploy — this
 * number has been re-tuned repeatedly and each round otherwise costs a build:
 *   localStorage.setItem("nsSpeechLimitDb", "20")   then rejoin the call
 */
// 25 on real ears, chosen over 6 and then 15. Note this EQUALS DEFAULT_SUPPRESSION, so at the
// default depth the gate is now a no-op — `Math.min(limit, depth)` is the same number either
// way. That is deliberate and it is the answer to "it used to sound much better": the gate was
// added after that, and it was the gate taking the result away. It starts protecting speech
// again the moment the depth is raised above this.
const DEFAULT_SPEECH_LIMIT_DB = 25;

function speechLimitDb(): number {
  const v = loadPref<number>("nsSpeechLimitDb", DEFAULT_SPEECH_LIMIT_DB);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : DEFAULT_SPEECH_LIMIT_DB;
}
/**
 * The gate measures speech AGAINST THE ROOM, not against a fixed level.
 *
 * Absolute thresholds were the first attempt and they only work when nothing upstream moves
 * the signal. The browser's AGC does exactly that — it lifts a quiet room until its hiss
 * crosses any constant you pick, and the gate then reads silence as speech and never closes.
 * A guest cannot turn AGC off, so the fix cannot live in a setting.
 *
 * Speech runs 20–35 dB over the room it is spoken in, whatever the absolute level, so these
 * are margins over a tracked floor rather than dBFS values.
 */
// Raised from 12/6. At six, a steady room only a few dB above its own floor kept the gate
// OPEN — and an open gate means the limit sits at the speech limit, so the fan came through
// untouched while the model was allowed to cut almost nothing. Speech runs 20–35 dB over the
// room, so fourteen is still well clear of it, and closing at nine leaves the floor free to
// re-learn (it only falls quickly while the gate is shut).
const OPEN_MARGIN_DB = 14;
/** Lower than the open margin: the gap is what stops the gate chattering on a steady room. */
const CLOSE_MARGIN_DB = 9;
/** Keep the gate open this long after the level drops, so word gaps are not treated as silence. */
const HOLD_MS = 250;
const POLL_MS = 40;
/** Settle toward a quieter room fast — that reading is the floor, by definition. */
const FLOOR_FALL = 0.3;
/** Creep up slowly when the room genuinely gets noisier, so a fan is learned but a word is not. */
const FLOOR_RISE = 0.02;
/**
 * While the gate is open the level IS speech, so learning from it is how a floor climbs into
 * the voice and stops opening at all — the exact failure the VAD in audioPipeline hit when it
 * tried tracking the floor. Not zero, though: a vacuum cleaner that runs for a minute holds
 * the gate open, and only an upward crawl gets the floor above it again.
 */
// ~2 minutes of UNBROKEN signal to adapt. Real speech never is: the gaps between phrases
// close the gate, and the floor falls back fast. A vacuum cleaner has no gaps, so it is the
// one thing this rate actually learns — which is the point. An earlier 0.002 here adapted in
// twenty seconds and walked the floor straight up into a monologue.
const FLOOR_RISE_OPEN = 0.00033;

/**
 * The room's noise floor, one reading at a time.
 *
 * Pure, so the thing most likely to misbehave can be checked without an AudioContext.
 */
export function trackFloor(floor: number, db: number, open: boolean): number {
  if (open) return floor + FLOOR_RISE_OPEN * (db - floor);
  return floor + (db < floor ? FLOOR_FALL : FLOOR_RISE) * (db - floor);
}

/**
 * Should the gate be open (i.e. is this speech)?
 *
 * Two margins over the floor with a hold. Separate from the audio plumbing so its behaviour
 * can be reasoned about — and checked — on paper.
 */
export function gateOpen(db: number, floor: number, wasOpen: boolean, msSinceLoud: number): boolean {
  if (wasOpen) return db > floor + CLOSE_MARGIN_DB || msSinceLoud < HOLD_MS;
  return db > floor + OPEN_MARGIN_DB;
}

/** The parts of the package's processor we reach into; it exposes them, but does not type them. */
type DfnOpts = { track?: MediaStreamTrack; mediaStreamTrack?: MediaStreamTrack };

interface DfnInternals {
  init: (opts: DfnOpts) => Promise<void>;
  restart: (opts: DfnOpts) => Promise<void>;
  destroy: () => Promise<void>;
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  processor: { setSuppressionLevel: (level: number) => void };
}

function attachSpeechGate(proc: DfnInternals, depth: number): void {
  const origInit = proc.init.bind(proc);
  const origRestart = proc.restart.bind(proc);
  const origDestroy = proc.destroy.bind(proc);
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const limitWhileOpen = speechLimitDb();

  const start = (): void => {
    stop();
    const ctx = proc.audioContext;
    const src = proc.sourceNode;
    // Fail soft and loudly enough to find later: without the gate the filter still works,
    // it is just the aggressive one we started from.
    if (ctx === null || src === null) {
      log.warn("speech gate not attached — the processor exposed no input node");
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    let open = false;
    let lastLoud = 0;
    // Seeded from the first reading rather than a constant, so the gate is right from the
    // first word instead of converging on the way there.
    let floor: number | null = null;
    let applied = depth;
    proc.processor.setSuppressionLevel(depth);

    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const s of buf) sum += s * s;
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
      const now = ctx.currentTime * 1000;

      floor = floor === null ? db : trackFloor(floor, db, open);
      if (db > floor + CLOSE_MARGIN_DB) lastLoud = now;

      open = gateOpen(db, floor, open, now - lastLoud);
      const want = open ? Math.min(limitWhileOpen, depth) : depth;
      if (want !== applied) {
        proc.processor.setSuppressionLevel(want);
        applied = want;
      }
    }, POLL_MS);
  };

  // Wake the context the package just built. It creates one and wires a graph into it, but
  // never resumes it — and a suspended context runs no graph at all, so the destination node
  // LiveKit publishes carries silence. Chrome hands out a context that resumes readily and hid
  // this; Firefox and Safari keep it suspended until some later gesture, which is exactly the
  // "she was inaudible, then after a while we could hear her" that a guest reported: her next
  // click woke it. RNNoise has had this since the day it was written — see ensureRunning in
  // ./noise-suppression; DeepFilterNet never got it.
  // Fired, not awaited. init() is what LiveKit waits on before the track goes anywhere, and
  // nothing here should be able to hold that up — waking the context is best effort, and the
  // gate below attaches to a suspended context perfectly well.
  const wake = (): void => {
    const ctx = proc.audioContext;
    if (ctx !== null) void ensureRunning(ctx);
  };

  proc.init = async (opts) => { await origInit(opts); wake(); start(); };
  // Switching microphone builds a new source node, and the old analyser is left reading a
  // node nothing flows through — the gate would then sit closed and the model would be back
  // to full depth on every word.
  proc.restart = async (opts) => { await origRestart(opts); wake(); start(); };
  // The package tears the worklet down here; the interval has to go with it, or it keeps
  // poking a processor that no longer has anything behind it.
  proc.destroy = async () => { stop(); await origDestroy(); };
}

/**
 * A LiveKit audio TrackProcessor running DeepFilterNet 3. The package already
 * implements LiveKit's interface, so this only pins the configuration — and adds the
 * speech gate above, which is what keeps the model off the words.
 */
export function createDeepFilterProcessor(level?: number): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  const depth = level ?? suppressionLevel();
  log.info("DeepFilterNet processor created", { level: depth, gate: true });
  const proc = DeepFilterNoiseFilter({
    sampleRate: 48000,
    enableNoiseReduction: true,
    noiseReductionLevel: depth,
    assetConfig: { cdnUrl: ASSET_BASE },
  });
  attachSpeechGate(proc as unknown as DfnInternals, depth);
  return proc as unknown as TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>;
}
