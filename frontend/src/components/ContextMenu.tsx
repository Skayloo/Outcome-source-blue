import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuEntry {
  /** A clickable row. */
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  icon?: ReactNode;
  /** A custom row (e.g. a volume slider) rendered as-is; not auto-closed on click. */
  render?: () => ReactNode;
  separator?: boolean;
}

/** A lightweight right-click context menu anchored at viewport (x, y), clamped on-screen. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8);
    const top = Math.min(y, window.innerHeight - r.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    // Defer attaching the outside-click listener so the very right-click that
    // opened this menu (mousedown/contextmenu of the same gesture) doesn't
    // immediately close it.
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("contextmenu", onDown);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("contextmenu", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Rendered into <body>, not next to whatever was right-clicked. The menu is
  // position:fixed, and the panels it opens over are frosted glass — a backdrop-filter
  // makes its element the containing block for fixed descendants and clips them to its
  // rounded box, so a menu left in place would land at the wrong coordinates with half
  // of it cut off at the panel edge.
  return createPortal((
    <div ref={ref} className="ctx-menu" style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="ctx-sep" />;
        if (it.render) return <div key={i} className="ctx-custom">{it.render()}</div>;
        return (
          <button
            key={i}
            className={"ctx-item" + (it.danger ? " danger" : "")}
            onClick={() => { it.onClick?.(); onClose(); }}
          >
            {it.icon && <span className="ctx-icon">{it.icon}</span>}
            <span>{it.label}</span>
          </button>
        );
      })}
    </div>
  ), document.body);
}
