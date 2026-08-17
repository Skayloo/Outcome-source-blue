/** Fullscreen image viewer (lightbox) — holds the opened album and which of it is showing. */
import { createStore } from "@lib/store";

export interface LightboxItem {
  readonly url: string;
  readonly alt: string;
  /** The downscaled copy, already in the browser's cache because the album drew it. Shown for
   *  the moment the screen-sized one takes to arrive — without it the viewer keeps painting the
   *  PREVIOUS picture until the next decodes, which reads as two photos being the same. */
  readonly thumb?: string;
  /** The untouched upload, for "open original". What is DISPLAYED is `url`, which is the
   *  screen-sized copy: the original is several megabytes the window cannot use. */
  readonly full?: string;
}

interface LightboxState {
  readonly items: readonly LightboxItem[];
  readonly index: number;
}

export const lightboxStore = createStore<LightboxState>({ items: [], index: 0 }, true);

/** One picture, or a whole album opened at the one that was clicked. */
export function openLightbox(url: string, alt?: string): void;
export function openLightbox(items: readonly LightboxItem[], index?: number): void;
export function openLightbox(a: string | readonly LightboxItem[], b?: string | number): void {
  if (typeof a === "string") {
    lightboxStore.setState(() => ({ items: [{ url: a, alt: (b as string) ?? "" }], index: 0 }));
    return;
  }
  const index = Math.min(Math.max((b as number) ?? 0, 0), Math.max(a.length - 1, 0));
  lightboxStore.setState(() => ({ items: a, index }));
}

export function closeLightbox(): void {
  lightboxStore.setState(() => ({ items: [], index: 0 }));
}

/** Move within the album; stops at both ends rather than wrapping. */
export function stepLightbox(delta: number): void {
  lightboxStore.setState((prev) => {
    if (prev.items.length === 0) return prev;
    const next = Math.min(Math.max(prev.index + delta, 0), prev.items.length - 1);
    return next === prev.index ? prev : { ...prev, index: next };
  });
}
