// =============================================================================
// VAD (Voice Activity Detection) AudioWorklet Processor
//
// Runs on the audio rendering thread. Computes RMS energy per audio frame and
// sends gating decisions to the main thread via MessagePort. This replaces
// setTimeout-based polling which pauses when the app is backgrounded.
//
// Protocol:
//   Main → Worklet:  { type: "config", threshold, gateOnMs, gateOffMs }
//   Main → Worklet:  { type: "stop" }
//   Worklet → Main:  { type: "gate", gated: boolean }
//   Worklet → Main:  { type: "rms", value: number }  (optional, for VAD indicator)
//
// Hold times are MILLISECONDS on the wire, converted to render quanta here.
// They used to be frame counts, copied verbatim from the setTimeout version this replaced —
// where a tick was ~16ms. A render quantum is 128 samples, which at 48kHz is 2.67ms, so
// every hold ran about six times too short: the gate shut after 32ms of quiet instead of
// 200ms. Thirty milliseconds is a pause INSIDE a word — the closure before a t, k or p — so
// the gate slammed mid-syllable and reopened 5ms later, over and over. That amplitude
// modulation on top of speech is what people described as a quacking, robotic voice.
// =============================================================================

class VadProcessor extends AudioWorkletProcessor {
  /** Milliseconds → render quanta, at least one. */
  _ms(ms) {
    return Math.max(1, Math.round(ms * this._quantaPerMs));
  }

  constructor() {
    super();
    // One render quantum is 128 samples; `sampleRate` is a global in this scope.
    const sr = typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : 48000;
    this._quantaPerMs = sr / 1000 / 128;

    this._threshold = 0.05;
    this._gateOnQuanta = this._ms(200);   // quiet before the gate shuts
    this._gateOffQuanta = this._ms(32);   // speech before it opens
    this._silentFrames = 0;
    this._speechFrames = 0;
    this._gated = false;
    this._active = true;
    this._startupFrames = 0;
    this._startupGrace = this._ms(500);
    this._frameCounter = 0;    // for throttled RMS updates

    this.port.onmessage = (event) => {
      if (event.data.type === "config") {
        this._threshold = event.data.threshold;
        if (event.data.gateOnMs !== undefined) this._gateOnQuanta = this._ms(event.data.gateOnMs);
        if (event.data.gateOffMs !== undefined) this._gateOffQuanta = this._ms(event.data.gateOffMs);
        // Reset state on config change
        this._silentFrames = 0;
        this._speechFrames = 0;
        this._startupFrames = 0;
        if (this._gated) {
          this._gated = false;
          this.port.postMessage({ type: "gate", gated: false });
        }
      } else if (event.data.type === "stop") {
        this._active = false;
      }
    };
  }

  process(inputs) {
    if (!this._active) return false; // Returning false stops the processor

    const input = inputs[0];
    if (input === undefined || input.length === 0 || input[0] === undefined) return true;

    const samples = input[0];
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / samples.length);

    // Grace period: don't gate for the first ~500ms to let audio settle
    if (this._startupFrames < this._startupGrace) {
      this._startupFrames++;
      return true;
    }

    // Send RMS value to main thread every ~6 frames (~50ms at 128 samples/frame @ 48kHz)
    // This is used for the VAD indicator bar in the UI
    this._frameCounter++;
    if (this._frameCounter >= 6) {
      this._frameCounter = 0;
      this.port.postMessage({ type: "rms", value: rms });
    }

    // One threshold, as before. A second, lower one to close on was tried and removed: it
    // would hold the gate OPEN for any steady noise sitting between the two, which is the
    // opposite of what a room with traffic in it needs. The chatter it guards against is
    // what the hold times above are for, and those were the actual bug.
    if (rms < this._threshold) {
      this._speechFrames = 0;
      this._silentFrames++;
      if (!this._gated && this._silentFrames >= this._gateOnQuanta) {
        this._gated = true;
        this.port.postMessage({ type: "gate", gated: true });
      }
    } else {
      this._silentFrames = 0;
      this._speechFrames++;
      if (this._gated && this._speechFrames >= this._gateOffQuanta) {
        this._gated = false;
        this.port.postMessage({ type: "gate", gated: false });
      }
    }

    return true;
  }
}

registerProcessor("vad-processor", VadProcessor);
