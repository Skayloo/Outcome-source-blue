// Runnable check for the adaptive make-up gain:  node scripts/makeup-gain-check.mjs
//
// What this pins is the bug it replaces. The make-up gain used to be the constant 2, on the
// assumption that the browser had already brought the microphone somewhere near a usable
// level. Chrome does. macOS does it for Safari. Firefox does not — we asked it not to, with
// autoGainControl: false — so a guest on Firefox was inaudible while the same call sounded
// fine to everyone else. One number cannot serve a quiet laptop microphone and a headset at
// once, and no amount of tuning that number ever will.
//
// The arithmetic is pure on purpose: how loud everybody sounds should be checkable without a
// browser, a microphone or a call.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// Lifted from the module rather than reimplemented — a copy here would pass while the shipped
// function drifted, which is exactly the kind of test that is worse than none.
const block = readFileSync(new URL("../src/lib/makeupGain.ts", import.meta.url), "utf8")
  .replace(/^export /gm, "")
  .replace(/: number/g, "");
assert.ok(!/^import /m.test(block), "makeupGain.ts must stay free of imports for this check");
const nextMakeupGain = new Function(`${block}; return nextMakeupGain;`)();

const TARGET = 0.05;

/** Run the loop to rest and report where it settled and how long it took. */
function settle(rms, from = 2, steps = 400) {
  let g = from;
  for (let i = 0; i < steps; i++) {
    const next = nextMakeupGain(g, rms);
    if (Math.abs(next - g) < 1e-9) return { gain: g, steps: i };
    g = next;
  }
  return { gain: g, steps };
}

// ── A quiet microphone is brought up to the target, which is the whole point.
{
  const quiet = 0.006;                       // roughly -44 dBFS, a bare laptop mic on Firefox
  const { gain } = settle(quiet, 2, 2000);
  const out = quiet * gain;
  assert.ok(Math.abs(out - TARGET) < TARGET * 0.15,
    `a quiet mic should end up near the target, got ${out.toFixed(4)}`);
  assert.ok(gain > 5, `it needs real lift, got ${gain.toFixed(2)}`);
}

// ── The case that started this: a Mac built-in mic on Firefox, quieter than the old floor.
{
  const bare = 0.0025;                       // about -52 dBFS
  const { gain } = settle(bare, 2, 2000);
  const out = bare * gain;
  assert.ok(out > TARGET * 0.7,
    `speech this quiet must still be lifted, got ${out.toFixed(4)} at ×${gain.toFixed(1)}`);
}

// ── A loud one is brought DOWN to the same target, not merely stopped from rising. This is
//    what makes Chrome and Firefox meet: one has to come down as much as the other goes up.
{
  const loud = 0.2;                          // about -14 dBFS, Chrome's AGC on a good mic
  const { gain } = settle(loud, 8, 2000);
  const out = loud * gain;
  assert.ok(Math.abs(out - TARGET) < TARGET * 0.3,
    `a loud mic must be pulled to the target too, got ${out.toFixed(4)} at ×${gain.toFixed(2)}`);
  assert.ok(gain < 1, `which means attenuating, got ×${gain.toFixed(2)}`);
}

// ── Silence never moves it. Winding the gain up through every pause is what pumping is.
{
  const held = nextMakeupGain(4, 0.0005);
  assert.equal(held, 4, "silence must leave the gain exactly where it was");
  assert.equal(nextMakeupGain(4, 0), 4, "digital silence too");
}

// ── Bounds hold even for absurd input.
{
  const CEILING = Number(/MAX_MAKEUP = ([\d.]+)/.exec(
    readFileSync(new URL("../src/lib/makeupGain.ts", import.meta.url), "utf8"))[1]);
  assert.ok(settle(0.0013, 1, 2000).gain <= CEILING, "never above the ceiling");
  const FLOOR = Number(/MIN_MAKEUP = ([\d.]+)/.exec(
    readFileSync(new URL("../src/lib/makeupGain.ts", import.meta.url), "utf8"))[1]);
  assert.ok(settle(0.9, 12, 2000).gain >= FLOOR, "never below the floor");
  assert.ok(Number.isFinite(nextMakeupGain(2, NaN)) , "NaN must not poison the gain");
  assert.equal(nextMakeupGain(2, NaN), 2, "NaN leaves it alone");
}

// ── It must not lurch. A single step that jumps to the answer is audible as a pump.
{
  const one = nextMakeupGain(1, 0.006);
  assert.ok(one < 1.1, `rise is gradual, got ${one.toFixed(3)} in one step`);
  const down = nextMakeupGain(12, 0.2);
  assert.ok(down > 9, `fall is quicker but still not a jump, got ${down.toFixed(3)}`);
  assert.ok(down < 12, "and it does move");
}

// ── Falling is faster than rising: overshoot into clipping is the one that must not linger.
{
  const riseSteps = settle(0.006, 1).steps;
  const fallSteps = settle(0.2, 12).steps;
  assert.ok(fallSteps < riseSteps, `down must be quicker than up, ${fallSteps} vs ${riseSteps}`);
}

console.log("makeup gain OK");
