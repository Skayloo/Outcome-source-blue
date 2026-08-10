/**
 * A themed replacement for window.confirm — one imperative `confirm(...)` that returns a
 * Promise<boolean>, so call sites read exactly like the native one they replace:
 *
 *   if (!(await confirm({ message: t("..."), danger: true }))) return;
 *
 * A single host is mounted once at the app root; `confirm()` renders into it, resolves on
 * the user's choice, and tears itself down. Keeps every destructive-action prompt inside
 * the app's own visual language instead of the browser's grey OS box.
 */
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { t } from "@lib/i18n";

export interface ConfirmOptions {
  readonly title?: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  readonly danger?: boolean;
  /** A substring of `message` to emphasise (e.g. the account name being deleted), so it is
   *  unmistakable WHO/WHAT the action hits. Highlighted wherever it occurs in the message. */
  readonly highlight?: string;
  /** Render a single-line text field; its value comes back via `prompt()` instead of `confirm()`. */
  readonly input?: { placeholder?: string; maxLength?: number };
}

/** Split `message` around every occurrence of `highlight`, wrapping the matches in an
 *  accent span. Plain text when there's nothing to highlight. */
function renderMessage(message: string, highlight?: string) {
  if (highlight === undefined || highlight.length === 0 || !message.includes(highlight)) {
    return message;
  }
  const parts = message.split(highlight);
  return parts.flatMap((part, i) =>
    i === 0
      ? [part]
      : [<span key={i} className="confirm-highlight">{highlight}</span>, part],
  );
}

let host: Root | null = null;

function ensureHost(): Root {
  if (host) return host;
  const el = document.createElement("div");
  el.id = "confirm-host";
  document.body.appendChild(el);
  host = createRoot(el);
  return host;
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const root = ensureHost();
    const done = (result: string | null) => {
      root.render(null);
      resolve(result !== null);
    };
    root.render(<ConfirmDialog options={options} onDone={done} />);
  });
}

/** Same dialog with a text field: resolves to what the user typed, or null when cancelled. */
export function prompt(options: ConfirmOptions & { input: NonNullable<ConfirmOptions["input"]> }): Promise<string | null> {
  return new Promise((resolve) => {
    const root = ensureHost();
    const done = (result: string | null) => {
      root.render(null);
      resolve(result);
    };
    root.render(<ConfirmDialog options={options} onDone={done} />);
  });
}

function ConfirmDialog({ options, onDone }: { options: ConfirmOptions; onDone: (r: string | null) => void }) {
  const [closing, setClosing] = useState(false);
  const [value, setValue] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = (ok: boolean) => {
    if (closing) return;
    setClosing(true);
    onDone(ok ? value : null);
  };

  useEffect(() => {
    // With a field, the caret belongs in it — otherwise the confirm button takes focus.
    if (options.input) inputRef.current?.focus();
    else confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-overlay visible" onMouseDown={() => close(false)}>
      <div className="modal confirm-modal" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
        <div className="modal-header">
          <h3>{options.title ?? t("common.confirmTitle")}</h3>
        </div>
        <div className="modal-body confirm-message">
          {renderMessage(options.message, options.highlight)}
          {options.input && (
            <input
              ref={inputRef}
              className="form-input"
              style={{ marginTop: 12 }}
              maxLength={options.input.maxLength ?? 200}
              placeholder={options.input.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={() => close(false)}>
            {options.cancelLabel ?? t("common.cancel")}
          </button>
          <button
            ref={confirmRef}
            className={options.danger ? "btn-confirm danger" : "btn-confirm"}
            onClick={() => close(true)}
          >
            {options.confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
