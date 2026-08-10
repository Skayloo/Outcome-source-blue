/**
 * Appearance settings tab — theme, font size, compact mode, accent color.
 * Ported from the deprecated Tauri client's AppearanceTab.ts.
 */
import { useEffect, useState } from "react";
import { Section, Row, Slider, ToggleRow } from "@components/settings/controls";
import { loadPref, savePref } from "@components/settings/helpers";
import { applyTheme, applyFontSize } from "@lib/applyPreferences";
import { t, setLocale, getLocale, LOCALES } from "@lib/i18n";

interface ThemeOpt {
  value: string;
  labelKey: string;
}

// Labels resolved through t() at render so they follow the active locale.
const THEMES: readonly ThemeOpt[] = [
  { value: "graphite", labelKey: "settings.themeGraphite" },
  { value: "deep-ink", labelKey: "settings.themeDeepInk" },
  { value: "light", labelKey: "settings.themeDaylight" },
  { value: "neon-glow", labelKey: "settings.themeNeon" },
  { value: "midnight", labelKey: "settings.themeMidnight" },
];

// Preset accent swatches (hex with leading "#" for display; stored without it).
const ACCENT_PRESETS: readonly string[] = [
  "#8b5cf6", // iris (brand default)
  "#22d3ee", // cyan
  "#34d399", // emerald
  "#fbbf24", // amber
  "#fb7185", // rose
  "#f472b6", // pink
  "#f97316", // orange
  "#60a5fa", // sky
  "#a78bfa", // lavender
  "#94a3b8", // slate
];

/** Apply an accent (bare hex, no "#") to the document, matching applyAllPreferences. */
function applyAccent(hex: string): void {
  const de = document.documentElement;
  if (hex) {
    de.style.setProperty("--accent", "#" + hex);
    document.body.style.setProperty("--accent", "#" + hex);
  }
}

export function AppearanceTab() {
  const [theme, setThemeState] = useState<string>(() => loadPref<string>("theme", "graphite"));
  // Accent stored without a leading "#".
  const [accent, setAccent] = useState<string>(() => loadPref<string>("accentColor", ""));

  // Apply saved values on mount so the UI reflects persisted state.
  useEffect(() => {
    applyTheme(loadPref<string>("theme", "graphite"));
    applyFontSize();
    document.documentElement.classList.toggle("compact-mode", loadPref<boolean>("compactMode", false));
    const savedAccent = loadPref<string>("accentColor", "");
    if (savedAccent) applyAccent(savedAccent);
  }, []);

  const selectTheme = (name: string): void => {
    setThemeState(name);
    applyTheme(name);
    savePref("theme", name);
  };

  const pickAccent = (hex: string): void => {
    setAccent(hex);
    savePref("accentColor", hex);
    applyAccent(hex);
  };

  const onHexInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
    setAccent(raw);
    if (raw.length === 6) {
      savePref("accentColor", raw);
      applyAccent(raw);
    }
  };

  return (
    <div className="settings-pane active">
      <Section title={t("settings.language")} />
      <Row label={t("settings.language")} desc={t("settings.languageDesc")}>
        <select className="settings-select" value={getLocale()} onChange={(e) => setLocale(e.target.value)}>
          {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </Row>

      <Section title={t("settings.theme")} />
      <div className="theme-options" role="radiogroup">
        {THEMES.map((th) => {
          const active = th.value === theme;
          const label = t(th.labelKey);
          return (
            <button
              key={th.value}
              type="button"
              className={`theme-opt ${th.value}${active ? " active" : ""}`}
              role="radio"
              aria-checked={active}
              aria-label={label}
              onClick={() => selectTheme(th.value)}
            >
              {label}
            </button>
          );
        })}
      </div>

      <Section title={t("settings.fontSize")} />
      <Row label={t("settings.fontSize")} desc={t("settings.fontSizeDesc")}>
        <Slider
          k="fontSize"
          def={14}
          min={12}
          max={24}
          step={1}
          format={(n) => n + "px"}
          onChange={() => applyFontSize()}
        />
      </Row>

      <ToggleRow
        label={t("settings.compactMode")}
        desc={t("settings.compactModeDesc")}
        k="compactMode"
        def={false}
        onChange={(v) => document.documentElement.classList.toggle("compact-mode", v)}
      />

      <Section title={t("settings.accentColor")} />
      <div className="accent-swatches">
        {ACCENT_PRESETS.map((color) => {
          const bare = color.slice(1);
          const active = bare === accent;
          return (
            <div
              key={color}
              className={`accent-swatch${active ? " active" : ""}`}
              style={{ backgroundColor: color, color }}
              title={color}
              role="radio"
              tabIndex={0}
              aria-label={color}
              aria-checked={active}
              onClick={() => pickAccent(bare)}
              onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pickAccent(bare);
                }
              }}
            />
          );
        })}
      </div>
      <div className="accent-hex-row">
        <span className="accent-hex-prefix">#</span>
        <input
          className="form-input"
          type="text"
          maxLength={6}
          placeholder="5865f2"
          value={accent}
          style={{ width: 120 }}
          onChange={onHexInput}
        />
      </div>
    </div>
  );
}
