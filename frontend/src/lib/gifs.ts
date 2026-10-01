/**
 * The user's GIF reaction library (W3GWG-25 stage 3): theirs on every device, kept on the server.
 * Loaded on first use — most people never open the picker — and kept for the session.
 */
import { api } from "@lib/services";
import { createStore } from "@lib/store";
import type { GifItem } from "@lib/types";

/** The owner's limits, checked again by the server; here so the picker can say so before
 *  a five-megabyte upload has been sent. */
export const GIF_MAX_BYTES = 5 * 1024 * 1024;
export const GIF_MAX_COUNT = 50;
export const GIF_ACCEPT = "image/gif,image/webp";

interface GifState { readonly items: readonly GifItem[] | null; readonly busy: boolean }

export const gifsStore = createStore<GifState>({ items: null, busy: false }, true);

export async function loadGifs(): Promise<void> {
  if (gifsStore.getState().items !== null) return;
  try {
    const items = await api.listGifs();
    gifsStore.setState((s) => ({ ...s, items }));
  } catch { /* the picker shows the empty state; the next open tries again */ }
}

/** Upload one; returns an error to show, or null. */
export async function addGif(file: File): Promise<string | null> {
  if (!["image/gif", "image/webp"].includes(file.type)) return "type";
  if (file.size > GIF_MAX_BYTES) return "size";
  if ((gifsStore.getState().items?.length ?? 0) >= GIF_MAX_COUNT) return "count";
  gifsStore.setState((s) => ({ ...s, busy: true }));
  try {
    const item = await api.uploadGif(file);
    gifsStore.setState((s) => ({ items: [item, ...(s.items ?? [])], busy: false }));
    return null;
  } catch (e) {
    gifsStore.setState((s) => ({ ...s, busy: false }));
    return e instanceof Error ? e.message : "failed";
  }
}

export async function removeGif(id: number): Promise<void> {
  const before = gifsStore.getState().items;
  gifsStore.setState((s) => ({ ...s, items: (s.items ?? []).filter((g) => g.id !== id) }));
  try { await api.deleteGif(id); }
  catch { gifsStore.setState((s) => ({ ...s, items: before })); }
}
