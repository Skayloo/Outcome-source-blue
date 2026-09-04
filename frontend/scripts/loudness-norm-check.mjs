// node frontend/scripts/loudness-norm-check.mjs
//
// The receive-side normaliser has one job and three ways to get it wrong: amplify silence,
// overshoot, or move fast enough to be heard. This checks all three.
import assert from "node:assert/strict";
import { nextNormGain, TARGET_RMS, SPEECH_FLOOR_RMS, MIN_GAIN, MAX_GAIN } from "../src/lib/loudnessNorm.ts";

const settle = (rms, from = 1, steps = 200) => {
  let g = from;
  for (let i = 0; i < steps; i++) g = nextNormGain(g, rms);
  return g;
};

// A quiet speaker is lifted to the target, a loud one is brought down to it — within the
// bounds, which is the point of having them: 0.025 wants x1.6, 0.06 wants x0.67.
assert.ok(Math.abs(settle(0.025) * 0.025 - TARGET_RMS) < 1e-6, "quiet speaker reaches the target");
assert.ok(Math.abs(settle(0.06) * 0.06 - TARGET_RMS) < 1e-6, "loud speaker reaches the target");

// Outside the bounds it corrects as far as it is allowed and no further — a broken microphone
// is not this function's job.
assert.equal(settle(0.005 + SPEECH_FLOOR_RMS), MAX_GAIN, "a very quiet speaker stops at MAX_GAIN");

// Silence changes nothing — no hiss pumped up between sentences.
assert.equal(nextNormGain(1.7, 0), 1.7, "silence leaves the factor alone");
assert.equal(nextNormGain(1.7, SPEECH_FLOOR_RMS / 2), 1.7, "below the floor leaves it alone");
assert.equal(nextNormGain(1.3, NaN), 1.3, "a bad reading leaves it alone");

// Bounds hold even for absurd input.
assert.equal(settle(0.0001 + SPEECH_FLOOR_RMS), MAX_GAIN, "never above MAX_GAIN");
assert.equal(settle(1.0), MIN_GAIN, "never below MIN_GAIN");

// One step is small: nothing audible as a jump, from either direction.
assert.ok(nextNormGain(1, 0.005 + SPEECH_FLOOR_RMS) <= 1.04 + 1e-9, "rise is gradual");
assert.ok(nextNormGain(1, 0.5) >= 0.97 - 1e-9, "fall is gradual");

// And it never steps past the target.
assert.ok(nextNormGain(1, TARGET_RMS / 1.01) <= 1.01, "no overshoot upward");

console.log("loudness normaliser ok");
