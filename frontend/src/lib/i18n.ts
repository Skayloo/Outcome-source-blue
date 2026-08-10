/**
 * Minimal i18n. `t(key)` looks up the active locale's string (falling back to en,
 * then the key itself). Locale lives in the `language` preference. A single
 * `useT()` subscription mounted at the App root re-renders the whole tree on
 * change, so leaf components only need the plain `t()` function.
 */
import { useEffect, useReducer } from "react";
import { loadPref, savePref } from "@components/settings/helpers";
import { en } from "@lib/locales/en";
import { ru } from "@lib/locales/ru";

export type Locale = "en" | "ru";
export type Dict = Record<string, string>;

const DICTS: Record<Locale, Dict> = { en, ru };
const SUPPORTED: Locale[] = ["en", "ru"];

let locale: Locale = normalize(loadPref<string>("language", "en"));
const listeners = new Set<() => void>();

function normalize(l: string): Locale {
  return (SUPPORTED as string[]).includes(l) ? (l as Locale) : "en";
}

export function getLocale(): Locale { return locale; }

export function setLocale(l: string): void {
  locale = normalize(l);
  savePref("language", locale);
  document.documentElement.setAttribute("lang", locale);
  for (const fn of listeners) fn();
}

/** Translate a key with optional `{param}` interpolation. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = DICTS[locale][key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** Mount once at the app root: re-renders the tree whenever the locale changes. */
export function useT(): typeof t {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => { listeners.delete(force); };
  }, []);
  return t;
}

export const LOCALES: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
];
