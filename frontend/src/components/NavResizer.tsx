import { useEffect, useRef, useState } from "react";

const KEY = "outcome.navWidth";
/** Narrow enough to be a rail of names, wide enough to be a reading list. Past the upper
 *  bound the chat starts paying for it, which is the one thing this must not do. */
const MIN = 240;
const MAX = 560;
export const DEFAULT_NAV_WIDTH = 300;

export function readNavWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= MIN && n <= MAX ? n : DEFAULT_NAV_WIDTH;
  } catch {
    return DEFAULT_NAV_WIDTH;
  }
}

/**
 * Drag the conversation list wider or narrower by its edge, the way desktop messengers do.
 *
 * Tracked 1:1 against the pointer from where it was grabbed — not from the panel's edge, so
 * the strip does not jump under the cursor on the first pixel of movement. The pointer is
 * captured, so a fast drag that outruns the strip keeps resizing instead of stopping dead the
 * moment the cursor leaves it.
 */
export function NavResizer({ onWidth }: { onWidth: (px: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });

  useEffect(() => {
    document.body.classList.toggle("nav-resizing", dragging);
    return () => document.body.classList.remove("nav-resizing");
  }, [dragging]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const nav = e.currentTarget.parentElement;
    if (!nav) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: nav.getBoundingClientRect().width };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const next = Math.min(MAX, Math.max(MIN, start.current.w + (e.clientX - start.current.x)));
    onWidth(next);
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    const w = Math.min(MAX, Math.max(MIN, start.current.w + (e.clientX - start.current.x)));
    try { localStorage.setItem(KEY, String(Math.round(w))); } catch { /* private mode */ }
  };

  return (
    <div
      className={"nav-resizer" + (dragging ? " dragging" : "")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      // Double-click puts it back, which is the way out of a width dragged somewhere silly.
      onDoubleClick={() => {
        onWidth(DEFAULT_NAV_WIDTH);
        try { localStorage.setItem(KEY, String(DEFAULT_NAV_WIDTH)); } catch { /* ignore */ }
      }}
    />
  );
}
