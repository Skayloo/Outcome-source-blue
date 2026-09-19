// Which messages a channel keeps in memory while you scroll back through it.
//
// Import-free on purpose so scripts/message-window-check.mjs can run it under plain node.

/** Ceiling for a channel the user is actively scrolling back through. */
export const MAX_LOADED_PER_CHANNEL = 5000;

/**
 * The window after a page of OLDER messages is prepended.
 *
 * Trims from the NEWEST end, and that direction is the whole point. The previous version kept
 * the newest 500 of `[...older, ...existing]` — so in a channel already holding 500 it sliced
 * off exactly the page it had just fetched. History stopped dead at whatever date the 500th
 * message fell on, every further scroll refetched and rediscarded the same page, and a reply
 * pointing above that line showed as "Deleted message" because its parent could never be in the
 * store. The iOS client has no such cap and showed the same conversation whole, which is how it
 * was spotted.
 */
export function windowAfterPrepend<T>(older: readonly T[], existing: readonly T[]): T[] {
  const combined = [...older, ...existing];
  return combined.length > MAX_LOADED_PER_CHANNEL
    ? combined.slice(0, MAX_LOADED_PER_CHANNEL)
    : combined;
}
