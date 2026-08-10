import { useEffect, useState } from "react";
import { useStoreState } from "@lib/useStore";
import { authStore } from "@stores/auth.store";
import { openSettings } from "@stores/ui.store";
import { logout } from "@lib/session";
import { roleColor } from "@lib/format";
import { Avatar } from "@components/Avatar";
import { loadPref } from "@components/settings/helpers";
import { t } from "@lib/i18n";
import { Icon } from "@lib/icons";

const STATUS: Record<string, { color: string; labelKey: string }> = {
  online: { color: "#2ecc71", labelKey: "sidebar.statusOnline" },
  idle: { color: "#f1c40f", labelKey: "sidebar.statusIdle" },
  dnd: { color: "#e74c3c", labelKey: "sidebar.statusDnd" },
  offline: { color: "#747f8d", labelKey: "sidebar.statusInvisible" },
};

export function UserBar() {
  const auth = useStoreState(authStore);
  const user = auth.user;
  const [status, setStatus] = useState<string>(loadPref("userStatus", "online"));

  // React to status changes made in the Account settings tab.
  useEffect(() => {
    const onPref = (e: Event) => {
      const key = (e as CustomEvent<{ key: string }>).detail?.key;
      if (key === "userStatus") setStatus(loadPref("userStatus", "online"));
    };
    window.addEventListener("outcome:pref", onPref);
    return () => window.removeEventListener("outcome:pref", onPref);
  }, []);

  const s = STATUS[status] ?? { color: "#2ecc71", labelKey: "sidebar.statusOnline" };

  return (
    <div className="user-bar">
      <div className="ub-avatar">
        <Avatar username={user?.username ?? "?"} avatar={user?.avatar ?? null} size={32} color={roleColor(user?.role)} />
        <span className="status-dot" style={{ background: s.color }} />
      </div>
      <div className="ub-info">
        <div className="ub-name">{user?.username ?? "—"}</div>
        <div className="ub-status">{t(s.labelKey)}</div>
      </div>
      <div className="ub-controls">
        <button title={t("sidebar.settings")} onClick={openSettings}><Icon name="settings" size={20} /></button>
        <button title={t("sidebar.logOut")} onClick={logout}><Icon name="log-out" size={20} /></button>
      </div>
    </div>
  );
}
