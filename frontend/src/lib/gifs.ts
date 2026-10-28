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
// A "GIF" saved from Telegram and most sites is a short MP4 (or MOV/WebM): the server turns it into
// an animated WebP, kept to the same 5 MB, so a video may come in larger.
export const GIF_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
export const GIF_ACCEPT = "image/gif,image/webp,video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm";
const VIDEO = /^video\/(mp4|quicktime|webm|x-m4v)$|\.(mp4|mov|m4v|webm)$/i;

interface GifState { readonly items: readonly GifItem[] | null; readonly busy: boolean }

export const gifsStore = createStore<GifState>({ items: null, busy: false }, true);

export async function loadGifs(): Promise<void> {
  if (gifsStore.getState().items !== null) return;
  try {
    const items = await api.listGifs();
    gifsStore.setState((s) => ({ ...s, items }));
  } catch { /* the picker shows the empty state; the next open tries again */ }
}

/** What is wrong with a file as a GIF reaction before it is sent, or null — the server checks again. */
export function gifFileProblem(file: File): "type" | "size" | null {
  const video = VIDEO.test(file.type) || VIDEO.test(file.name);
  if (!video && !["image/gif", "image/webp"].includes(file.type)) return "type";
  return file.size > (video ? GIF_VIDEO_MAX_BYTES : GIF_MAX_BYTES) ? "size" : null;
}

/** Upload one; returns an error to show, or null. */
export async function addGif(file: File): Promise<string | null> {
  const problem = gifFileProblem(file);
  if (problem) return problem;
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
