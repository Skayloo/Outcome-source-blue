// node scripts/rnnoise-sync-check.mjs
//
// Checks the exact contract the AudioWorklet depends on. The previous worklet asked the raw
// .wasm for `rnnoise_create` and got nothing — silently, on every call, falling back to the
// main thread. This asserts the names it uses now really exist AND that a frame comes back
// changed and finite, which is the difference between "the module loaded" and "it denoises".
import assert from "node:assert/strict";
import createRNNWasmModuleSync from "../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise-sync.js";

const FRAME = 480;
const mod = createRNNWasmModuleSync();

for (const fn of ["_rnnoise_create", "_rnnoise_destroy", "_rnnoise_process_frame", "_malloc", "_free"]) {
  assert.equal(typeof mod[fn], "function", `${fn} must exist — the worklet calls it by this exact name`);
}
assert.ok(mod.HEAPF32 instanceof Float32Array, "HEAPF32 must be a heap view");

const state = mod._rnnoise_create();
assert.ok(state, "rnnoise_create returned a state");
const inPtr = mod._malloc(FRAME * 4);
const outPtr = mod._malloc(FRAME * 4);
assert.ok(inPtr && outPtr, "allocation succeeded");

// Speech-ish tone buried in noise, at the int16 scale the worklet uses.
const heapIn = inPtr / 4;
for (let i = 0; i < FRAME; i++) {
  const s = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.3 + (Math.random() - 0.5) * 0.2;
  mod.HEAPF32[heapIn + i] = s * 32768;
}
const before = Array.from(mod.HEAPF32.subarray(heapIn, heapIn + FRAME));

mod._rnnoise_process_frame(state, outPtr, inPtr);

const out = mod.HEAPF32.subarray(outPtr / 4, outPtr / 4 + FRAME);
assert.ok(out.every(Number.isFinite), "every output sample is finite");
assert.ok(out.some((v, i) => v !== before[i]), "the frame actually went through the model");

mod._free(inPtr);
mod._free(outPtr);
mod._rnnoise_destroy(state);
console.log("rnnoise sync module ok");
