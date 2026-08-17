/**
 * Split view: a second conversation beside the first.
 *
 * Deliberately one extra pane and not an arbitrary tree of them. Two is where the value is —
 * watch a channel while answering a DM — and an editor-style dock manager would be a large
 * amount of machinery for a third pane nobody asked for. If a third is ever wanted, this is
 * the place that grows.
 *
 * The left pane always follows the app's focused channel, so every existing screen keeps
 * working untouched; only the right pane has state of its own.
 */
import { createStore } from "@lib/store";
import { loadPref, savePref } from "@lib/preferences";

export interface PanesState {
  /** Channel shown on the right, or null when the view is not split. */
  readonly secondary: number | null;
  /** Left pane's share of the width, 0.2–0.8. */
  readonly ratio: number;
}

const RATIO_KEY = "splitRatio";
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 0.75;

export const panesStore = createStore<PanesState>({
  // Not restored on load: reopening the app to a split the user forgot about is a surprise,
  // and the width they chose is the part actually worth remembering.
  secondary: null,
  ratio: clampRatio(loadPref<number>(RATIO_KEY, 0.5)),
}, true);

export function clampRatio(r: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

/** Open a channel in the right pane (or move the right pane to it). */
export function openInSplit(channelId: number): void {
  panesStore.setState((prev) => ({ ...prev, secondary: channelId }));
}

export function closeSplit(): void {
  panesStore.setState((prev) => ({ ...prev, secondary: null }));
}

/** Live during a drag — persisted by [commitRatio] once the pointer is released. */
export function setRatio(ratio: number): void {
  panesStore.setState((prev) => ({ ...prev, ratio: clampRatio(ratio) }));
}

export function commitRatio(): void {
  savePref(RATIO_KEY, panesStore.getState().ratio);
}
