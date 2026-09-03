/**
 * The packaged desktop shell, as seen from the SPA.
 *
 * The same bundle runs in a browser and inside Electron, so everything here is
 * feature-detected: in a browser `window.outcomeDesktop` is simply absent and every function
 * below is a no-op. No separate build, no `if (isElectron)` scattered through components.
 */

export interface DesktopBridge {
  version: string;
  platform: string;
  setPushToTalk(accelerator: string): Promise<boolean>;
  setBadge(count: number): Promise<boolean>;
  onPushToTalk(handler: () => void): () => void;
  openExternal(url: string): Promise<boolean>;
  onSso(handler: (payload: { token: string; error: string }) => void): () => void;
}

declare global {
  interface Window { outcomeDesktop?: DesktopBridge }
}

/** The shell, or null when this is an ordinary browser tab. */
export function desktop(): DesktopBridge | null {
  return typeof window !== "undefined" && window.outcomeDesktop ? window.outcomeDesktop : null;
}

export const isDesktop = (): boolean => desktop() !== null;

/**
 * Translate a `KeyboardEvent.code` — what the settings screen records — into an Electron
 * accelerator, which is a different vocabulary: the browser says "KeyT" and "Digit4" where
 * Electron wants "T" and "4".
 *
 * Returns "" for a key Electron cannot express globally. That is not a failure to hide: the
 * caller shows the user that this particular key works only while the window is focused,
 * which is the truth.
 */
export function codeToAccelerator(code: string): string {
  if (!code) return "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return "num" + code.slice(6);

  const named: Record<string, string> = {
    Space: "Space",
    Tab: "Tab",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  return named[code] ?? "";
}
