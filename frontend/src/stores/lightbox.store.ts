/** Fullscreen image viewer (lightbox) — holds the currently opened image URL. */
import { createStore } from "@lib/store";

interface LightboxState {
  readonly url: string | null;
  readonly alt: string;
}

export const lightboxStore = createStore<LightboxState>({ url: null, alt: "" });

export function openLightbox(url: string, alt = ""): void {
  lightboxStore.setState(() => ({ url, alt }));
}

export function closeLightbox(): void {
  lightboxStore.setState(() => ({ url: null, alt: "" }));
}
