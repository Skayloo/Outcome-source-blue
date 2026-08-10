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

const log = createLogger("noise-suppression-dfn");

/** Where the self-hosted model and wasm live (see public/dfn/). */
const ASSET_BASE = "/dfn";

/**
 * How deep the model cuts, on its own 0–100 scale.
 *
 * 40 for everyone. Higher is not better: at full depth the model takes the quiet ends of
 * words along with the noise, and the speaker hears themselves perfectly while everyone
 * else hears them clipped. At 40 a fan and a street are gone and speech is untouched, which
 * is the trade worth defaulting to — the slider is there for rooms that need more.
 */
const DEFAULT_SUPPRESSION = 40;

export function suppressionLevel(): number {
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
  await Promise.all(files.map(async (url) => {
    try {
      // The BODY has to be consumed, not just the response awaited: a fetch whose body is
      // never read gets its download cancelled and leaves nothing in the HTTP cache, so the
      // package then fetched all 12 MB a second time. Read it and drop it.
      const res = await fetch(url, { cache: "force-cache", priority: "low" } as RequestInit);
      await res.arrayBuffer();
    } catch (err) {
      log.debug("DeepFilterNet prefetch skipped", { url, err });
    }
  }));
  savePref(WARMED_KEY, true);
  log.info("DeepFilterNet assets warmed");
}

/**
 * A LiveKit audio TrackProcessor running DeepFilterNet 3. The package already
 * implements LiveKit's interface, so this only pins the configuration.
 */
export function createDeepFilterProcessor(level?: number): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  const depth = level ?? suppressionLevel();
  log.info("DeepFilterNet processor created", { level: depth });
  return DeepFilterNoiseFilter({
    sampleRate: 48000,
    enableNoiseReduction: true,
    noiseReductionLevel: depth,
    assetConfig: { cdnUrl: ASSET_BASE },
  }) as unknown as TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>;
}
