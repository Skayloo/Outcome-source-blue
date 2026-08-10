export const STORAGE_PREFIX = "outcome:settings:";
const LEGACY_PREFIX = "owncord:settings:";

/** Read a persisted preference (JSON) with a fallback. */
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Persist a preference as JSON. Dispatches `outcome:pref` so live consumers can react. */
export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent("outcome:pref", { detail: { key } }));
  } catch {
    /* ignore */
  }
}

/**
 * One-time migration: copy any legacy `owncord:settings:*` keys into the
 * canonical `outcome:settings:*` namespace (without overwriting existing
 * values). Lets settings carried over from the deprecated client keep working.
 */
export function migrateLegacyPrefs(): void {
  try {
    const toCopy: Array<[string, string]> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LEGACY_PREFIX)) continue;
      const newKey = STORAGE_PREFIX + key.slice(LEGACY_PREFIX.length);
      if (localStorage.getItem(newKey) === null) {
        const v = localStorage.getItem(key);
        if (v !== null) toCopy.push([newKey, v]);
      }
    }
    for (const [k, v] of toCopy) localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
