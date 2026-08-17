/**
 * Voice attachments THIS user has played (Telegram's listened state). Seeded from
 * message history (`listened` on attachments), advanced when playback starts here
 * or on another device (`voice_listened` frames).
 */

import { createStore } from "@lib/store";

export interface ListenedState {
  readonly listened: ReadonlySet<string>;
  /** Clips of MINE that someone else has played — clears the sender-side dot. */
  readonly listenedByOthers: ReadonlySet<string>;
}

export const listenedStore = createStore<ListenedState>({ listened: new Set(), listenedByOthers: new Set() }, true);

export function isListened(attachmentId: string): boolean {
  return listenedStore.getState().listened.has(attachmentId);
}

export function markListened(attachmentId: string): void {
  if (isListened(attachmentId)) return;
  listenedStore.setState((s) => {
    const next = new Set(s.listened);
    next.add(attachmentId);
    return { ...s, listened: next };
  });
}

export function markListenedBulk(ids: readonly string[]): void {
  if (ids.length === 0) return;
  listenedStore.setState((s) => {
    const next = new Set(s.listened);
    for (const id of ids) next.add(id);
    return { ...s, listened: next };
  });
}

export function markListenedByOthers(attachmentId: string): void {
  if (listenedStore.getState().listenedByOthers.has(attachmentId)) return;
  listenedStore.setState((s) => {
    const next = new Set(s.listenedByOthers);
    next.add(attachmentId);
    return { ...s, listenedByOthers: next };
  });
}

export function markListenedByOthersBulk(ids: readonly string[]): void {
  if (ids.length === 0) return;
  listenedStore.setState((s) => {
    const next = new Set(s.listenedByOthers);
    for (const id of ids) next.add(id);
    return { ...s, listenedByOthers: next };
  });
}
