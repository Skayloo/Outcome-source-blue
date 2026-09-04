// Loudness normalisation, receiver side.
//
// Different microphones, different browsers and different distances from the mouth land people
// at wildly different levels — and the ONE place that difference must not be fixed is the
// sender: the browser's AGC already regulates there, and a second regulator racing it is what
// made Chrome deafening and Firefox quiet at the same time. So the levelling happens here,
// where every voice is judged against the same target on one listener's machine and nobody's
// signal is rewritten for everyone else.
//
// Import-free on purpose so scripts/loudness-norm-check.mjs can run it under plain node.

/** Where a speaking voice should land, in RMS of the decoded signal. */
export const TARGET_RMS = 0.04;

/** Below this the participant is not speaking; silence must never be amplified — that is how
 *  a normaliser turns a quiet room into a hiss generator between sentences. */
export const SPEECH_FLOOR_RMS = 0.006;

/** Bounds. Deliberately narrow: this corrects a difference, it does not rescue a broken
 *  microphone, and a listener who hears a voice swing by 8× will call that the bug. */
export const MIN_GAIN = 0.5;
export const MAX_GAIN = 2.5;

/** Per step, and steps are ~400 ms apart: about 4 s to cross the whole range. Slow enough that
 *  nobody hears it move, which is the entire difference between "levelled" and "pumping". */
const RISE = 1.04;
const FALL = 0.97;

/**
 * The next normalisation factor for one participant.
 *
 * `rms` is measured on their decoded audio. Returns `current` unchanged while they are silent,
 * so the factor a speaker settled at is still there when they speak again.
 */
export function nextNormGain(current: number, rms: number): number {
  if (!Number.isFinite(rms) || rms < SPEECH_FLOOR_RMS) return current;
  const wanted = TARGET_RMS / rms;
  const next = wanted > current ? current * RISE : current * FALL;
  // Never overshoot the target in a single step: on a loud speaker `wanted` can be far below
  // `current`, and stepping past it makes the correction audible as a dip.
  const clampedToWanted = wanted > current ? Math.min(next, wanted) : Math.max(next, wanted);
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, clampedToWanted));
}
