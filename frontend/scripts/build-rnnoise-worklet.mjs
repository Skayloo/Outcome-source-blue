// Builds public/rnnoise-worklet.js — run it after changing scripts/rnnoise-worklet.src.js
// or bumping @jitsi/rnnoise-wasm:
//
//   node scripts/build-rnnoise-worklet.mjs
//
// An AudioWorklet is a classic script on the audio thread: no fetch, no import, no waiting on
// anything. So RNNoise has to arrive already inside the file, which is exactly what the
// package's `-sync` build is for — the WASM is a base64 data URI and compilation is
// synchronous. Jitsi ships it the same way.
//
// The alternative we had before this was to fetch the raw .wasm and instantiate it by hand.
// That cannot work with a closure-minified emscripten build: its exports are named d, e, f, g
// and its imports are a.a / a.b, so the check for `rnnoise_create` failed every time and the
// denoiser quietly ran on the deprecated ScriptProcessorNode instead — on the main thread.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const glueFile = join(here, "../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise-sync.js");
const srcFile = join(here, "rnnoise-worklet.src.js");
const outFile = join(here, "../public/rnnoise-worklet.js");

let glue = readFileSync(glueFile, "utf8");

// Two ES-module constructs, both fatal in a classic script.
const before = glue;
glue = glue.replace("import.meta.url", '""');
glue = glue.replace(/^export default createRNNWasmModuleSync;\s*$/m, "");
if (glue === before) throw new Error("rnnoise-sync.js no longer looks like the expected ES module");
if (!/createRNNWasmModuleSync/.test(glue)) throw new Error("the sync factory is missing from the glue");

const src = readFileSync(srcFile, "utf8");
if (!/createRNNWasmModuleSync\(\)/.test(src)) throw new Error("the worklet no longer calls the sync factory");

writeFileSync(outFile, [
  "// GENERATED FILE — do not edit. Source: scripts/rnnoise-worklet.src.js",
  "// Rebuild: node scripts/build-rnnoise-worklet.mjs",
  "",
  "// --- @jitsi/rnnoise-wasm (sync build, WASM inlined) -------------------------",
  glue,
  "// --- our processor ---------------------------------------------------------",
  src,
].join("\n"));

const kb = (readFileSync(outFile).length / 1024) | 0;
console.log(`public/rnnoise-worklet.js written (${kb} KB)`);
