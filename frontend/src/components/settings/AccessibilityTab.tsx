/**
 * Accessibility settings tab — reduce motion, high contrast, large font, role
 * colors, and OS motion sync. Ported from the deprecated Tauri client's
 * AccessibilityTab. Each toggle persists its preference (via the ToggleRow `k`)
 * AND applies a live class on <html> so the change is visible immediately.
 *
 * Notes on the two "inverted" toggles:
 *  - roleColors (default ON): the document class is `no-role-colors`, added only
 *    when the toggle is OFF.
 *  - syncOsMotion: when ON we follow `matchMedia("(prefers-reduced-motion:
 *    reduce)")` to drive `reduced-motion`; when OFF we fall back to the user's
 *    manual `reducedMotion` preference. The media-query listener is torn down on
 *    toggle-off and on unmount.
 */
import { useEffect, useRef } from "react";
import { ToggleRow } from "@components/settings/controls";
import { loadPref } from "@components/settings/helpers";
import { applyFontSize } from "@lib/applyPreferences";
import { t } from "@lib/i18n";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Apply the `reduced-motion` class from the saved manual preference. */
function applyManualReducedMotion(): void {
  document.documentElement.classList.toggle("reduced-motion", loadPref("reducedMotion", false));
}

export function AccessibilityTab() {
  // Holds the teardown fn for the active OS-motion matchMedia listener (if any).
  const osMotionCleanup = useRef<(() => void) | null>(null);

  /** Start syncing `reduced-motion` with the OS preference. Replaces any prior listener. */
  const startOsMotionSync = (): void => {
    osMotionCleanup.current?.();
    const mq = window.matchMedia(MOTION_QUERY);
    document.documentElement.classList.toggle("reduced-motion", mq.matches);
    const onChange = (e: MediaQueryListEvent): void => {
      document.documentElement.classList.toggle("reduced-motion", e.matches);
    };
    mq.addEventListener("change", onChange);
    osMotionCleanup.current = () => mq.removeEventListener("change", onChange);
  };

  /** Stop syncing with the OS and restore the manual reduced-motion preference. */
  const stopOsMotionSync = (): void => {
    osMotionCleanup.current?.();
    osMotionCleanup.current = null;
    applyManualReducedMotion();
  };

  // On mount: reflect every saved accessibility preference onto <html>, and start
  // the OS-motion listener if it was previously enabled. On unmount: tear the
  // listener down so it doesn't outlive the settings view.
  useEffect(() => {
    document.documentElement.classList.toggle("reduced-motion", loadPref("reducedMotion", false));
    document.documentElement.classList.toggle("high-contrast", loadPref("highContrast", true));
    document.documentElement.classList.toggle("large-font", loadPref("largeFont", false));
    document.documentElement.classList.toggle("no-role-colors", !loadPref("roleColors", true));
    if (loadPref("syncOsMotion", false)) startOsMotionSync();
    return () => {
      osMotionCleanup.current?.();
      osMotionCleanup.current = null;
    };
  }, []);

  return (
    <div className="settings-pane active">
      <ToggleRow
        label={t("settings.reduceMotion")}
        desc={t("settings.reduceMotionDesc")}
        k="reducedMotion"
        def={false}
        onChange={(on: boolean) => {
          // When OS sync is active it owns the reduced-motion class; otherwise apply manually.
          if (!osMotionCleanup.current) {
            document.documentElement.classList.toggle("reduced-motion", on);
          }
        }}
      />
      <ToggleRow
        label={t("settings.highContrast")}
        desc={t("settings.highContrastDesc")}
        k="highContrast"
        def={true}
        onChange={(on: boolean) => {
          document.documentElement.classList.toggle("high-contrast", on);
        }}
      />
      <ToggleRow
        label={t("settings.largeFont")}
        desc={t("settings.largeFontDesc")}
        k="largeFont"
        def={false}
        onChange={(on: boolean) => {
          document.documentElement.classList.toggle("large-font", on);
          applyFontSize(); // recompute base size (+bump) immediately
        }}
      />
      <ToggleRow
        label={t("settings.roleColors")}
        desc={t("settings.roleColorsDesc")}
        k="roleColors"
        def={true}
        onChange={(on: boolean) => {
          document.documentElement.classList.toggle("no-role-colors", !on);
        }}
      />
      <ToggleRow
        label={t("settings.syncOsMotion")}
        desc={t("settings.syncOsMotionDesc")}
        k="syncOsMotion"
        def={false}
        onChange={(on: boolean) => {
          if (on) startOsMotionSync();
          else stopOsMotionSync();
        }}
      />
    </div>
  );
}
