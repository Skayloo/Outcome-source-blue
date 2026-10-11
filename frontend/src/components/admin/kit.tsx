/**
 * The admin console's building blocks — one look for every section (2026-10-11).
 *
 * Before this each section drew its own: a heading repeating the page title, a row of filled
 * purple buttons per table row, red "Delete" next to "Kick". The rules here: one primary action
 * per screen, the rest secondary or ghost; destructive actions live behind "⋯" (RowMenu) and are
 * confirmed by the caller; a table row carries at most one visible action besides the menu.
 * Styles are in styles/admin.css under the `adm-` prefix, so the app's own settings are not
 * touched.
 */
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@lib/icons";
import { t } from "@lib/i18n";

type Kind = "primary" | "secondary" | "ghost" | "danger";

export function Btn({ kind = "secondary", icon, size, children, className, type = "button", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind; icon?: IconName; size?: "sm" }) {
  return (
    <button
      type={type}
      className={`adm-btn adm-btn--${kind}${size ? ` adm-btn--${size}` : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children !== undefined && <span>{children}</span>}
    </button>
  );
}

/** A square button that is only an icon; `label` is its tooltip and its accessible name. */
export const IconBtn = forwardRef<HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; active?: boolean }>(
  function IconBtn({ icon, label, active, className, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={"adm-iconbtn" + (active ? " is-active" : "") + (className ? ` ${className}` : "")}
      title={label}
      aria-label={label}
      {...rest}
    >
      <Icon name={icon} size={17} />
    </button>
  );
});

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export function Badge({ tone = "neutral", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={`adm-badge adm-badge--${tone}`}>{dot && <i className="adm-badge-dot" />}{children}</span>;
}

/** The row above a list: search and filters on the left, actions on the right. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="adm-toolbar">{children}</div>;
}

export function Spacer() {
  return <span className="adm-spacer" />;
}

export function SearchField({ value, onChange, placeholder, autoFocus }:
  { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <label className="adm-search">
      <Icon name="search" size={16} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button type="button" className="adm-search-clear" aria-label={t("admin.clear")} onClick={() => onChange("")}>
          <Icon name="x" size={14} />
        </button>
      )}
    </label>
  );
}

export function Empty({ icon = "inbox", title, text, children }:
  { icon?: IconName; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="adm-empty">
      <span className="adm-empty-icon"><Icon name={icon} size={22} /></span>
      <div className="adm-empty-title">{title}</div>
      {text && <div className="adm-empty-text">{text}</div>}
      {children}
    </div>
  );
}

export function Card({ title, desc, actions, children, flush }:
  { title?: string; desc?: string; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={"adm-card" + (flush ? " adm-card--flush" : "")}>
      {(title || actions) && (
        <header className="adm-card-head">
          <div>
            {title && <h2 className="adm-card-title">{title}</h2>}
            {desc && <p className="adm-card-desc">{desc}</p>}
          </div>
          {actions && <div className="adm-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  // A stable hue per name, so the same person keeps the same colour across the console.
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="adm-avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${h} 45% 38%)` }}>
      {letter}
    </span>
  );
}

export interface MenuItem {
  readonly label: string;
  readonly icon?: IconName;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

/** "⋯" with the less frequent and the destructive actions of a row. Drawn in a portal with
 *  fixed positioning: a table wrapper that scrolls would otherwise clip it. */
export function RowMenu({ items, label }: { items: readonly MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = 220;
    const height = menu.current?.offsetHeight ?? items.length * 38 + 12;
    const below = r.bottom + 6 + height < window.innerHeight;
    setPos({
      top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - height),
      left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
    });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "mousedown" && (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node))) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <IconBtn ref={btn} icon="more-horizontal" label={label ?? t("admin.more")} active={open} onClick={() => setOpen((v) => !v)} />
      {open && createPortal(
        <div ref={menu} className="adm-menu" role="menu" style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={"adm-menu-item" + (it.danger ? " is-danger" : "")}
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}
            >
              {it.icon && <Icon name={it.icon} size={16} />}
              <span>{it.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="adm-spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}
