import { useEffect, useState } from "react";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import { AdminDashboard } from "@components/admin/AdminDashboard";
import { AdminUsersPanel } from "@components/admin/AdminUsersPanel";
import { AdminAuditPanel } from "@components/admin/AdminAuditPanel";
import { AdminLogsPanel } from "@components/admin/AdminLogsPanel";
import { ServerSettingsPanel } from "@components/admin/ServerSettingsPanel";
import { RolesPanel } from "@components/admin/RolesPanel";
import { InviteManager } from "@components/admin/InviteManager";

type AdminTab =
  | "dashboard" | "users" | "roles" | "invites" | "server" | "audit" | "logs";

const TAB_TITLES: Record<AdminTab, () => string> = {
  dashboard: () => t("admin.dashboard"),
  users: () => t("admin.users"),
  roles: () => t("admin.roles"),
  invites: () => t("admin.invites"),
  server: () => t("admin.serverSettings"),
  audit: () => t("admin.auditLog"),
  logs: () => t("admin.serverLogs"),
};

/** Admin console — diagnostics, users, roles, invites, settings, audit log, live logs.
 *  Channel management lives on the /admin page's Servers panel (cross-tenant) and in the
 *  app itself (sidebar + / right-click), so there is no separate Channels tab. */
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<AdminTab>("dashboard");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <div className="settings-cat">{t("admin.adminConsole")}</div>
          {(Object.keys(TAB_TITLES) as AdminTab[]).map((key) => (
            <button
              key={key}
              className={"settings-nav-item" + (tab === key ? " active" : "")}
              onClick={() => setTab(key)}
            >{TAB_TITLES[key]()}</button>
          ))}
        </div>
        <div className="settings-content">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h1>{TAB_TITLES[tab]()}</h1>
            <button className="settings-close-btn" title={t("admin.closeEsc")} onClick={onClose}><Icon name="x" size={18} /></button>
          </div>
          {tab === "dashboard" && <AdminDashboard />}
          {tab === "users" && <AdminUsersPanel />}
          {tab === "roles" && <RolesPanel />}
          {tab === "invites" && <InviteManager />}
          {tab === "server" && <ServerSettingsPanel />}
          {tab === "audit" && <AdminAuditPanel />}
          {tab === "logs" && <AdminLogsPanel />}
        </div>
      </div>
    </div>
  );
}
