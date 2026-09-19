// npm run check   (or: node --experimental-strip-types scripts/message-window-check.mjs)
//
// NOT part of `npm run build`: it imports a .ts directly, which needs Node 22.6+, and the
// frontend image builds on node:20-alpine. Adding it to the build broke the image, not the code.
//
// The bug this guards against shipped and was found by a user: scrolling back in a busy DM
// stopped at a date and went no further, while the iOS client showed the whole history.
import assert from "node:assert/strict";
import { windowAfterPrepend, MAX_LOADED_PER_CHANNEL } from "../src/lib/messageWindow.ts";

const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// The exact shape that broke: a channel already holding 500, one page of 50 older ones.
const existing = ids(501, 1000);
const older = ids(451, 500);
const out = windowAfterPrepend(older, existing);

assert.equal(out.length, 550, "the fetched page is ADDED, not discarded");
assert.equal(out[0], 451, "the oldest fetched message is at the top");
assert.equal(out.at(-1), 1000, "and the newest is still at the bottom");
// The old code returned exactly `existing` — nothing gained, and scrolling could never advance.
assert.notDeepEqual(out, existing, "prepending must change the window");

// The ceiling trims the NEWEST, so the direction of travel keeps working.
const huge = windowAfterPrepend(ids(1, 100), ids(101, MAX_LOADED_PER_CHANNEL + 100));
assert.equal(huge.length, MAX_LOADED_PER_CHANNEL);
assert.equal(huge[0], 1, "what we scrolled into survives the trim");

console.log("message window ok");
