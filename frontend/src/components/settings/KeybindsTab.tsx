/**
 * Keybinds settings tab (web port).
 *
 * Push-to-talk: captures a single key via a one-shot window keydown listener
 * (10s timeout) and stores the DOM `event.code` string under the "pttKey" pref.
 * Unlike the deprecated desktop client (which used Rust-side GetAsyncKeyState
 * polling for true global hotkeys), the browser can only observe keys while the
 * Outcome window/tab is focused — hence the explicit note below.
 *
 * The remaining shortcut rows are reference-only display.
 */

import { useEffect, useRef, useState } from "react";
import { Section, Row } from "@components/settings/controls";
import { loadPref, savePref } from "@components/settings/helpers";
import { t } from "@lib/i18n";

const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * Read-only reference shortcuts grouped by section (reference only — not rebindable).
 * `sectionKey`/`labelKey` resolve through t() at render; modifier-combo shortcuts are
 * literal key names, but the descriptive PTT one uses a translatable key (`shortcutKey`).
 */
const REFERENCE_BINDS: ReadonlyArray<{
  sectionKey: string;
  binds: ReadonlyArray<{ labelKey: string; shortcut?: string; shortcutKey?: string }>;
}> = [
  {
    sectionKey: "settings.kbNavigation",
    binds: [
      { labelKey: "settings.kbQuickSwitcher", shortcut: "Ctrl + K" },
    ],
  },
  {
    sectionKey: "settings.kbVoiceSection",
    binds: [
      { labelKey: "settings.kbToggleMute", shortcut: "Ctrl + Shift + M" },
      { labelKey: "settings.kbToggleDeafen", shortcut: "Ctrl + Shift + D" },
      { labelKey: "settings.kbToggleCamera", shortcut: "Ctrl + Shift + V" },
      { labelKey: "settings.kbPushToTalk", shortcutKey: "settings.kbHoldPttKey" },
    ],
  },
  {
    sectionKey: "settings.kbReferenceSection",
    binds: [
      { labelKey: "settings.kbMarkAsRead", shortcut: "Esc" },
      { labelKey: "settings.kbSearch", shortcut: "Ctrl + F" },
      { labelKey: "settings.kbEditLastMessage", shortcut: "Arrow Up" },
    ],
  },
];

export function KeybindsTab() {
  const [pttKey, setPttKey] = useState<string>(() => loadPref<string>("pttKey", ""));
  const [capturing, setCapturing] = useState(false);

  // Refs so the cleanup effect can always tear down whatever capture is active.
  const cleanupRef = useRef<(() => void) | null>(null);

  // Ensure any in-flight capture (listener + timeout) is removed on unmount.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const startCapture = () => {
    if (capturing) return;
    setCapturing(true);

    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore lone modifier presses so the user can hold e.g. Ctrl to chord —
      // but allow them eventually; here we accept any concrete key code.
      e.preventDefault();
      e.stopPropagation();
      finish(e.code);
    };

    const timer = window.setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);

    const teardown = () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.clearTimeout(timer);
    };

    // `finish(null)` => timeout/cancel (keep current); `finish(code)` => set.
    const finish = (code: string | null) => {
      teardown();
      cleanupRef.current = null;
      setCapturing(false);
      if (code !== null) {
        setPttKey(code);
        savePref("pttKey", code);
      }
    };

    cleanupRef.current = teardown;
    window.addEventListener("keydown", onKeyDown, true);
  };

  const clearKey = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setCapturing(false);
    setPttKey("");
    savePref("pttKey", "");
  };

  return (
    <div className="settings-pane active">
      <Section title={t("settings.pushToTalk")} />

      <Row
        label={t("settings.pushToTalkKey")}
        desc={t("settings.pushToTalkKeyDesc")}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="kbd"
            style={{
              cursor: "pointer",
              minWidth: 96,
              textAlign: "center",
              ...(capturing ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}),
            }}
            title={t("settings.clickToCapture")}
            aria-label="Push to Talk key — click to capture"
            onClick={startCapture}
          >
            {capturing ? t("settings.pressAnyKey") : pttKey || t("settings.notSet")}
          </button>
          <button
            type="button"
            className="ac-btn"
            style={{ fontSize: 12, padding: "4px 10px", ...(pttKey ? {} : { display: "none" }) }}
            onClick={clearKey}
          >
            {t("settings.clear")}
          </button>
        </div>
      </Row>

      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          margin: "4px 0 16px 0",
          lineHeight: 1.4,
        }}
      >
        {t("settings.pttFocusNote")}
      </div>

      {REFERENCE_BINDS.map(({ sectionKey, binds }) => (
        <div key={sectionKey}>
          <div className="settings-separator" />
          <div className="keybind-section-header">{t(sectionKey)}</div>
          {binds.map((b) => (
            <div className="keybind-row" key={b.labelKey}>
              <span className="setting-label">{t(b.labelKey)}</span>
              <span className="kbd">{b.shortcutKey ? t(b.shortcutKey) : b.shortcut}</span>
            </div>
          ))}
        </div>
      ))}

      <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "12px 0 0 0" }}>
        {t("settings.kbFooterNote")}
      </div>
    </div>
  );
}
