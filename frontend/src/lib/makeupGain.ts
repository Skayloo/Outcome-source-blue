// The loudness normaliser's arithmetic, and nothing else.
//
// It lives alone because it is the part that decides how loud everybody sounds, and that
// deserves to be checkable without a browser, a microphone or a call — see
// scripts/makeup-gain-check.mjs, which reads this file directly. Anything imported here would
// have to be stubbed there, so nothing is.

/** Where the make-up gain starts, before a single measurement has been taken. */
export const MAKEUP_GAIN = 2;

/**
 * Loudness the normaliser aims the voice at, as RMS on the [-1, 1] scale — about -26 dBFS,
 * which is a comfortable speaking level with headroom left for the compressor.
 */
const TARGET_RMS = 0.05;

/**
 * Below this the input is a quiet room, not a voice: adapting to it would amplify silence.
 *
 * 0.0012 is about -58 dBFS. It started at 0.004 (-48 dBFS) and that was too high by exactly
 * the mistake this whole file exists to correct: a Mac's built-in microphone in Firefox with
 * AGC off produces speech around -50 dBFS, which sat UNDER the floor — so the normaliser
 * decided there was nothing to normalise and left the gain at its starting value. The person
 * had to shout to be noticed at all, which is the report that led here.
 */
const SPEECH_FLOOR_RMS = 0.0012;

/**
 * Bounds on the make-up gain. Forty is about +32 dB, which is what it actually takes to bring
 * a bare laptop microphone to a normal speaking level — twelve was chosen by reasoning about
 * what "ought" to be enough and turned out to be the ceiling a real machine sat against. The
 * compressor downstream catches the peaks that much lift can produce, and the transmission
 * gate keeps the pauses quiet, so the cost of a generous ceiling is bounded.
 */
// Attenuation allowed, and it has to be: Chrome's AGC lands around -16 dBFS where Firefox
// lands near -45, and bringing them to one loudness means pulling one DOWN as well as lifting
// the other. A floor of 1 could only ever lift, which left the two browsers as far apart as
// the browsers themselves.
const MIN_MAKEUP = 0.25;
const MAX_MAKEUP = 40;

/** How fast the gain may travel, per adaptation step. Coming DOWN is quicker than going up:
 *  overshooting into clipping must be corrected before anybody hears it, while creeping up
 *  slowly is what keeps the normaliser from pumping between words. */
const RISE_PER_STEP = 1.06;
const FALL_PER_STEP = 0.85;

/**
 * The next make-up gain, given the level we just measured. Pure, so the behaviour that decides
 * how loud everybody sounds can be checked without a browser — see scripts/makeup-gain-check.mjs.
 *
 * A fixed make-up gain was the mistake this replaces. It assumed the browser had already
 * brought the signal somewhere near a usable level, which Chrome does and macOS does for
 * Safari — and Firefox, quite correctly, does not, because we asked it not to. One number
 * cannot serve a quiet laptop microphone and a good headset at once; a measurement can.
 *
 * Returns the current gain unchanged while the input is below [SPEECH_FLOOR_RMS]: silence
 * carries no information about how loud a voice would be, and adapting to it would spend the
 * pause winding the gain up and the first word winding it back down.
 */
export function nextMakeupGain(current: number, rms: number): number {
  if (!Number.isFinite(rms) || rms < SPEECH_FLOOR_RMS) return current;
  const wanted = TARGET_RMS / rms;
  const stepped = wanted > current
    ? Math.min(current * RISE_PER_STEP, wanted)
    : Math.max(current * FALL_PER_STEP, wanted);
  return Math.min(MAX_MAKEUP, Math.max(MIN_MAKEUP, stepped));
}
