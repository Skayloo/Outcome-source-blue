// Runnable check for the VAD worklet's hold-time arithmetic:  node scripts/vad-worklet-check.mjs
//
// The bug this pins: hold times used to be frame counts copied from a setTimeout loop that
// ticked every 16ms, while a worklet frame is a 128-sample render quantum — 2.67ms at 48kHz.
// Every hold therefore ran six times too short and the gate shut inside a syllable. If the
// conversion ever drifts again, this fails instead of shipping a quacking microphone.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const QUANTUM = 128;
let Processor = null;

for (const rate of [48000, 44100]) {
  globalThis.sampleRate = rate;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
  globalThis.registerProcessor = (_name, cls) => { Processor = cls; };

  const src = readFileSync(new URL("../public/vad-worklet.js", import.meta.url), "utf8");
  new Function(src)();
  assert.ok(Processor, "registerProcessor was never called");

  const p = new Processor();
  const ms = (quanta) => (quanta * QUANTUM * 1000) / rate;

  // Within one quantum of the intended durations.
  assert.ok(Math.abs(ms(p._gateOnQuanta) - 200) < 3, `close hold at ${rate}Hz: ${ms(p._gateOnQuanta)}ms`);
  assert.ok(Math.abs(ms(p._gateOffQuanta) - 32) < 3, `open hold at ${rate}Hz: ${ms(p._gateOffQuanta)}ms`);
  assert.ok(Math.abs(ms(p._startupGrace) - 500) < 3, `startup grace at ${rate}Hz: ${ms(p._startupGrace)}ms`);

  // The close hold must outlast a stop-consonant closure, or the gate shuts mid-word.
  assert.ok(ms(p._gateOnQuanta) > 120, "close hold must exceed an intra-word pause");

  console.log(`  ${rate}Hz: close ${ms(p._gateOnQuanta).toFixed(0)}ms, open ${ms(p._gateOffQuanta).toFixed(0)}ms, grace ${ms(p._startupGrace).toFixed(0)}ms`);
}

// A missing sampleRate global must not throw inside the processor constructor: a throw there
// leaves the node alive but dead, which is silently no gating at all.
delete globalThis.sampleRate;
const src = readFileSync(new URL("../public/vad-worklet.js", import.meta.url), "utf8");
new Function(src)();
assert.ok(new Processor()._gateOnQuanta > 0, "must survive a missing sampleRate");
console.log("  no sampleRate: falls back, does not throw");

console.log("VAD worklet timings OK");
