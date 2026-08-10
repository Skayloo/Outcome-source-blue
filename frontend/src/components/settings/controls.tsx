/**
 * Shared settings primitives. They emit the deprecated client's CSS structure
 * (.setting-row / .toggle / .settings-select / .settings-slider …) which already
 * lives in app.css, so tabs look like the original desktop app for free.
 */
import { useState, type ReactNode } from "react";
import { loadPref, savePref } from "@components/settings/helpers";

/** Uppercase section sub-heading (renders an <h3>, styled by .settings-content h3). */
export function Section({ title }: { title: string }) {
  return <h3>{title}</h3>;
}

/** A label/description row with a control on the right. */
export function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

/** Discord-style switch. Controlled (via `on`) or self-persisting (via `k`). */
export function Toggle({ k, def, on: controlled, disabled, onChange }: { k?: string; def?: boolean; on?: boolean; disabled?: boolean; onChange?: (v: boolean) => void }) {
  const [on, setOn] = useState<boolean>(controlled ?? (k ? loadPref(k, def ?? false) : def ?? false));
  const value = controlled ?? on;
  const toggle = () => {
    if (disabled === true) return;
    const v = !value;
    setOn(v);
    if (k) savePref(k, v);
    onChange?.(v);
  };
  // A switch that is being overridden elsewhere must not keep showing itself as on: the
  // settings screen is where people go to find out what is actually running.
  return (
    <div
      className={"toggle" + (value && disabled !== true ? " on" : "") + (disabled === true ? " disabled" : "")}
      role="switch"
      aria-checked={value && disabled !== true}
      aria-disabled={disabled === true}
      onClick={toggle}
    />
  );
}

/** Convenience: a full toggle row that persists a boolean preference. */
export function ToggleRow({ label, desc, k, def, disabled, onChange }: { label: string; desc?: string; k: string; def: boolean; disabled?: boolean; onChange?: (v: boolean) => void }) {
  return <Row label={label} desc={desc}><Toggle k={k} def={def} disabled={disabled} onChange={onChange} /></Row>;
}

export interface Opt { value: string; label: string }

/** Dropdown. Controlled (via `value`) or self-persisting (via `k`). */
export function Select({ k, def, value, options, onChange }: { k?: string; def?: string; value?: string; options: Opt[]; onChange?: (v: string) => void }) {
  const [val, setVal] = useState<string>(value ?? (k ? loadPref(k, def ?? "") : def ?? ""));
  const current = value ?? val;
  return (
    <select
      className="settings-select"
      value={current}
      onChange={(e) => { const v = e.target.value; setVal(v); if (k) savePref(k, v); onChange?.(v); }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Range slider with a live value readout, persisting a number preference. */
export function Slider({ k, def, min, max, step, format, onChange }: { k: string; def: number; min: number; max: number; step?: number; format?: (n: number) => string; onChange?: (v: number) => void }) {
  const [val, setVal] = useState<number>(loadPref(k, def));
  return (
    <div className="slider-row" style={{ width: 240 }}>
      <input
        type="range" className="settings-slider"
        min={min} max={max} step={step ?? 1} value={val}
        onChange={(e) => { const v = Number(e.target.value); setVal(v); savePref(k, v); onChange?.(v); }}
      />
      <span className="slider-val">{format ? format(val) : String(val)}</span>
    </div>
  );
}

/** Inline status/result banner. */
export function Banner({ kind = "info", children }: { kind?: "info" | "error" | "success"; children: ReactNode }) {
  const color = kind === "error" ? "var(--red)" : kind === "success" ? "var(--green)" : "var(--text-muted)";
  return <div style={{ fontSize: 13, color, margin: "8px 0" }}>{children}</div>;
}
