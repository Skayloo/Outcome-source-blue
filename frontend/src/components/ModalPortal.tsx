import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * Renders a modal at the document root instead of where it was written.
 *
 * A modal opened from the sidebar or the chat header is written inside that panel,
 * and the panels are frosted glass: a backdrop-filter makes its element the
 * containing block for `position: fixed` descendants and clips them to its rounded
 * box. Without this, "Explore public servers" opened as a card squeezed inside the
 * 260px navigator column instead of centred over the app.
 *
 * Independent of the glass, this is where a modal belongs — nothing about it is
 * scoped to the panel that happened to open it.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
