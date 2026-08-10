/**
 * Notifications settings tab — desktop notifications, sounds, taskbar flash.
 * Ported from the deprecated Tauri client's NotificationsTab.ts.
 */

import { useEffect, useState } from "react";
import { Section, ToggleRow, Row, Toggle, Banner } from "@components/settings/controls";
import { requestNotificationPermission } from "@lib/notifications";
import { api } from "@lib/services";
import { t } from "@lib/i18n";

export function NotificationsTab() {
  const initial: NotificationPermission =
    "Notification" in window ? Notification.permission : "denied";
  const [permission, setPermission] = useState<NotificationPermission>(initial);
  const [requesting, setRequesting] = useState(false);
  // Server-side, not a local preference: the phone push is composed by the server, which is
  // the only place that knows whether it may put the text in.
  const [preview, setPreview] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    void api.getMe(ac.signal).then((me) => setPreview(me.push_preview !== false)).catch(() => {});
    return () => ac.abort();
  }, []);

  const handleEnable = async () => {
    setRequesting(true);
    try {
      const result = await requestNotificationPermission();
      setPermission(result);
    } finally {
      setRequesting(false);
    }
  };

  const bannerKind =
    permission === "granted" ? "success" : permission === "denied" ? "error" : "info";
  const bannerText =
    permission === "granted"
      ? t("settings.notifGranted")
      : permission === "denied"
        ? t("settings.notifDenied")
        : t("settings.notifDefault");

  return (
    <div className="settings-pane active">
      <Section title={t("settings.navNotifications")} />

      <button className="ac-btn" onClick={handleEnable} disabled={requesting}>
        {requesting ? t("settings.requestingEllipsis") : t("settings.enableDesktopNotifications")}
      </button>
      <Banner kind={bannerKind}>{bannerText}</Banner>

      <ToggleRow
        label={t("settings.desktopNotifications")}
        desc={t("settings.desktopNotificationsDesc")}
        k="desktopNotifications"
        def={true}
      />
      <ToggleRow
        label={t("settings.notificationSounds")}
        desc={t("settings.notificationSoundsDesc")}
        k="notificationSounds"
        def={true}
      />
      <ToggleRow
        label={t("settings.suppressEveryone")}
        desc={t("settings.suppressEveryoneDesc")}
        k="suppressEveryone"
        def={false}
      />
      <ToggleRow
        label={t("settings.flashTaskbar")}
        desc={t("settings.flashTaskbarDesc")}
        k="flashTaskbar"
        def={true}
      />

      <Section title={t("settings.pushSection")} />
      <Row label={t("settings.pushPreview")} desc={t("settings.pushPreviewDesc")}>
        <Toggle
          on={preview}
          onChange={(v) => {
            setPreview(v);
            void api.setPushPreview(v).catch(() => setPreview(!v));
          }}
        />
      </Row>
    </div>
  );
}
