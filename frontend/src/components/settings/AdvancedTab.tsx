/**
 * Advanced settings tab — developer mode, debug tools, and cache management.
 * Ported from the deprecated Tauri client's AdvancedTab to the React web app.
 *
 * Web caveats vs. the desktop original:
 *  - Hardware Acceleration is a desktop-only WebView setting, so it renders as a
 *    disabled toggle here.
 *  - "Open DevTools" can't be triggered programmatically in the browser, so it
 *    shows an instruction to press F12 instead.
 */
import { useEffect, useRef, useState } from "react";
import { Section, Row, Toggle, ToggleRow } from "@components/settings/controls";
import { clearLogBuffer } from "@lib/logger";
import { t } from "@lib/i18n";

/** Delete the IndexedDB image cache database (resolves even if blocked). */
function clearImageCache(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = indexedDB.deleteDatabase("outcome-image-cache");
    req.onsuccess = () => finish(resolve);
    req.onerror = () => finish(() => reject(req.error ?? new Error("deleteDatabase failed")));
    // If another tab holds the DB open, resolve anyway rather than hang.
    req.onblocked = () => finish(resolve);
  });
}

/** Clear the persisted client logs (in-memory buffer + localStorage copy). */
function clearLogFiles(): void {
  clearLogBuffer();
  localStorage.removeItem("outcome:logs");
}

/**
 * Clear localStorage but preserve user-critical data: keys containing
 * "profiles", "credentials", or "theme" are kept.
 */
function clearLocalStoragePreservingUserData(): void {
  const PRESERVE = ["profiles", "credentials", "theme"];
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && !PRESERVE.some((p) => key.includes(p))) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) localStorage.removeItem(key);
}

type BtnState = "idle" | "working" | "done" | "failed";

// Resolved through t() at render so labels follow the active locale.
function btnLabel(state: BtnState): string {
  switch (state) {
    case "idle": return t("settings.clear");
    case "working": return t("settings.clearing");
    case "done": return t("settings.cleared");
    case "failed": return t("settings.failed");
  }
}

export function AdvancedTab() {
  return (
    <div className="settings-pane active">
      <ToggleRow
        label={t("settings.developerMode")}
        desc={t("settings.developerModeDesc")}
        k="developerMode"
        def={false}
      />

      <Section title={t("settings.debug")} />

      <Row label={t("settings.hardwareAcceleration")} desc={t("settings.hardwareAccelerationDesc")}>
        <Toggle on={false} />
      </Row>

      <Row label={t("settings.openDevTools")} desc={t("settings.openDevToolsDesc")}>
        <span className="setting-desc">{t("settings.pressF12")}</span>
      </Row>

      <Section title={t("settings.storageAndCache")} />

      <CacheRow
        label={t("settings.clearImageCache")}
        desc={t("settings.clearImageCacheDesc")}
        action={clearImageCache}
      />

      <CacheRow
        label={t("settings.clearLogFiles")}
        desc={t("settings.clearLogFilesDesc")}
        action={clearLogFiles}
      />

      <ClearAllRow />
    </div>
  );
}

/** A row with a label/description and an async "Clear" button with status feedback. */
function CacheRow({
  label,
  desc,
  action,
}: {
  label: string;
  desc: string;
  action: () => void | Promise<void>;
}) {
  const [state, setState] = useState<BtnState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);

  const onClick = async () => {
    if (state === "working") return;
    setState("working");
    try {
      await action();
      setState("done");
    } catch {
      setState("failed");
    }
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Row label={label} desc={desc}>
      <button className="ac-btn" disabled={state === "working"} onClick={onClick}>
        {btnLabel(state)}
      </button>
    </Row>
  );
}

/** The nuclear "Clear All Cache & Restart" row with a two-step confirmation. */
function ClearAllRow() {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);

  const clearResetTimer = () => {
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  };

  const onClick = async () => {
    if (working) return;

    // First click: arm the confirmation and auto-disarm after 3s.
    if (!confirming) {
      setConfirming(true);
      resetTimer.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }

    // Second click: proceed.
    clearResetTimer();
    setConfirming(false);
    setWorking(true);
    try {
      await clearImageCache();
      clearLogFiles();
      clearLocalStoragePreservingUserData();
      sessionStorage.clear();
      location.reload();
    } catch {
      setWorking(false);
    }
  };

  let text = t("settings.clearAndRestart");
  if (working) text = t("settings.clearing");
  else if (confirming) text = t("settings.areYouSureClickAgain");

  return (
    <Row
      label={t("settings.clearAllCacheRestart")}
      desc={t("settings.clearAllCacheRestartDesc")}
    >
      <button
        className="ac-btn account-delete-btn"
        disabled={working}
        onClick={onClick}
      >
        {text}
      </button>
    </Row>
  );
}
