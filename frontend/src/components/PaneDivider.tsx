/**
 * The seam between the two panes. Drag it and the split follows the pointer exactly — no
 * easing, no animation, no waiting for release: the whole point of a divider is that it is
 * the thing under your finger.
 *
 * Pointer capture rather than window listeners, so a fast drag that outruns the cursor keeps
 * tracking instead of dropping the moment the pointer leaves the 6px hit area.
 */
import { useRef } from "react";
import { setRatio, commitRatio, MIN_RATIO, MAX_RATIO } from "@stores/panes.store";

export function PaneDivider() {
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    // Measured against the panes' container, not the window: the rail and sidebar sit to the
    // left of it and would offset every position by their width.
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setRatio((e.clientX - box.left) / box.width);
  };

  const end = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    commitRatio();
  };

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Ширина панелей"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      // A divider nobody can reach by keyboard is a divider some people simply cannot move.
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const box = e.currentTarget.parentElement?.getBoundingClientRect();
          if (!box) return;
          const current = (e.currentTarget.getBoundingClientRect().left - box.left) / box.width;
          setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, current + (e.key === "ArrowLeft" ? -step : step))));
          commitRatio();
        }
      }}
    >
      <span className="pane-divider-grip" />
    </div>
  );
}
