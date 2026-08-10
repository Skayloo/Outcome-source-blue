/**
 * Applies persisted UI preferences to the document at boot (and on demand).
 * Centralises everything main.tsx used to inline (theme + accent) plus the new
 * appearance/accessibility/log settings, so a reload reflects what the user set.
 */
import { loadPref } from "@components/settings/helpers";
import { setLogLevel, type LogLevel } from "@lib/logger";

/** Apply a named theme to <body>. "graphite" = the default identity (no class → tokens.css). */
export function applyTheme(name: string): void {
  document.body.classList.remove("theme-neon-glow", "theme-midnight", "theme-light", "theme-deep-ink");
  if (name === "neon-glow") document.body.classList.add("theme-neon-glow");
  else if (name === "midnight") document.body.classList.add("theme-midnight");
  else if (name === "light") document.body.classList.add("theme-light");
  else if (name === "deep-ink") document.body.classList.add("theme-deep-ink");
  // "graphite" (Warm Graphite + Iris) => no extra class, the tokens.css default
}

function setClass(name: string, on: boolean): void {
  document.documentElement.classList.toggle(name, on);
}

/** Default base font size (px). Large Font bumps it up to LARGE_FONT_SIZE. */
export const DEFAULT_FONT_SIZE = 14;
const LARGE_FONT_SIZE = 18;
/** Extra px added on top of the base when Large Font is enabled. */
export const LARGE_FONT_BUMP = LARGE_FONT_SIZE - DEFAULT_FONT_SIZE;

/** Resolve the effective base font size from the fontSize pref + Large Font toggle and
 *  apply it inline. Centralised so the slider, the toggle, and boot all agree — a CSS
 *  class can't do this because the inline --font-size (from the slider) would override it. */
export function applyFontSize(): void {
  const base = loadPref<number>("fontSize", DEFAULT_FONT_SIZE);
  const large = loadPref("largeFont", false);
  document.documentElement.style.setProperty("--font-size", (base + (large ? LARGE_FONT_BUMP : 0)) + "px");
}

/** Apply every persisted preference to the document. Safe to call repeatedly. */
export function applyAllPreferences(): void {
  const de = document.documentElement;

  applyTheme(loadPref("theme", "graphite"));

  // Accent must be set on BOTH <html> and <body>: the theme classes define --accent on
  // `body.theme-*`, which (being closer to the consumers) overrides an <html>-only value.
  // Setting it inline on <body> too wins over the theme rule — matching AppearanceTab's
  // applyAccent — so a saved accent survives reload instead of reverting to the theme default.
  const accent = loadPref<string>("accentColor", "");
  if (accent) {
    de.style.setProperty("--accent", "#" + accent);
    document.body.style.setProperty("--accent", "#" + accent);
  }

  applyFontSize();

  setClass("compact-mode", loadPref("compactMode", false));
  // High contrast is ON by default for everyone.
  setClass("high-contrast", loadPref("highContrast", true));
  setClass("large-font", loadPref("largeFont", false));
  setClass("no-role-colors", !loadPref("roleColors", true));

  // Reduced motion: manual pref OR (when syncing with OS) the OS preference.
  const syncOs = loadPref("syncOsMotion", false);
  const manualReduce = loadPref("reducedMotion", false);
  const osReduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  setClass("reduced-motion", manualReduce || (syncOs && osReduce));

  if (syncOs && window.matchMedia) {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener?.("change", () =>
      setClass("reduced-motion", loadPref("reducedMotion", false) || (loadPref("syncOsMotion", false) && mq.matches)));
  }

  setLogLevel(loadPref<LogLevel>("logMinLevel", "info"));
}
