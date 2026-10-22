/**
 * Standalone admin application at /admin — its OWN full-screen shell (sidebar + topbar),
 * NOT the in-app settings modal. Owner-only (gated in App.tsx). Reuses the existing admin
 * panels as section content.
 */
import { useState, useEffect } from "react";
import { authStore } from "@stores/auth.store";
import { useStoreState } from "@lib/useStore";
import { Icon, type IconName } from "@lib/icons";
import { Logo } from "@components/Logo";
import { t } from "@lib/i18n";
import { AdminDashboard } from "@components/admin/AdminDashboard";
import { AdminUsersPanel } from "@components/admin/AdminUsersPanel";
import { AdminAuditPanel } from "@components/admin/AdminAuditPanel";
import { AdminLogsPanel } from "@components/admin/AdminLogsPanel";
import { ServerSettingsPanel } from "@components/admin/ServerSettingsPanel";
import { RolesPanel } from "@components/admin/RolesPanel";
import { AdminInvitesPanel } from "@components/admin/AdminInvitesPanel";
import { AdminServersPanel } from "@components/admin/AdminServersPanel";
import { loadSpace, isRootSpace } from "@lib/space";
import { AdminBugsPanel } from "@components/admin/AdminBugsPanel";
import { AdminReportsPanel } from "@components/admin/AdminReportsPanel";
import { Toast } from "@components/Toast";

type Section =
  | "dashboard" | "logs" | "audit" | "users" | "servers" | "roles" | "invites" | "server" | "bugs" | "reports";

/** Sections that belong to whoever RUNS the instance: process-wide logs, infrastructure
 *  health, instance settings and the bug queue. The backend refuses them to anyone else too —
 *  this only keeps the console honest. */
const INSTANCE_ONLY: ReadonlySet<Section> = new Set<Section>(["dashboard", "logs", "bugs", "server"]);

interface NavItem { id: Section; icon: IconName; label: () => string }
interface NavGroup { title: () => string; items: NavItem[] }

const NAV: NavGroup[] = [
  { title: () => t("admin.grpOverview"), items: [
    { id: "dashboard", icon: "layout-dashboard", label: () => t("admin.dashboard") },
  ] },
  { title: () => t("admin.grpSystem"), items: [
    { id: "logs", icon: "scroll-text", label: () => t("admin.serverLogs") },
    { id: "audit", icon: "file-text", label: () => t("admin.auditLog") },
  ] },
  { title: () => t("admin.grpManage"), items: [
    { id: "users", icon: "users", label: () => t("admin.users") },
    { id: "servers", icon: "server", label: () => t("admin.servers") },
    { id: "roles", icon: "shield", label: () => t("admin.roles") },
    { id: "invites", icon: "user-plus", label: () => t("admin.invites") },
    { id: "reports", icon: "flag", label: () => t("admin.reports") },
    { id: "bugs", icon: "bug", label: () => t("admin.bugs") },
  ] },
  { title: () => t("admin.grpSettings"), items: [
    { id: "server", icon: "settings", label: () => t("admin.serverSettings") },
  ] },
];

const TITLES: Record<Section, () => string> = {
  dashboard: () => t("admin.dashboard"),
  logs: () => t("admin.serverLogs"),
  audit: () => t("admin.auditLog"),
  users: () => t("admin.users"),
  servers: () => t("admin.servers"),
  roles: () => t("admin.roles"),
  invites: () => t("admin.invites"),
  server: () => t("admin.serverSettings"),
  bugs: () => t("admin.bugs"),
  reports: () => t("admin.reports"),
};

const SUBTITLES: Record<Section, () => string> = {
  dashboard: () => t("admin.dashboardSub"),
  logs: () => t("admin.serverLogsSub"),
  audit: () => t("admin.auditLogSub"),
  users: () => t("admin.usersSub"),
  servers: () => t("admin.serversSub"),
  roles: () => t("admin.rolesSub"),
  invites: () => t("admin.invitesSub"),
  reports: () => t("admin.reportsSub"),
  bugs: () => t("admin.bugsSub"),
  server: () => t("admin.serverSettingsSub"),
};

/** Map the /admin[/section] path to the initial section. */
function sectionFromPath(): Section {
  const seg = window.location.pathname.replace(/^\/admin\/?/, "").split("/")[0];
  return (Object.keys(TITLES) as Section[]).includes(seg as Section) ? (seg as Section) : "dashboard";
}

export function AdminPage() {
  // Null until the host is resolved; treated as "tenant" meanwhile so operator sections
  // never flash on a customer's subdomain.
  const [isRoot, setIsRoot] = useState<boolean>(isRootSpace());
  useEffect(() => {
    void loadSpace().then((s) => {
      const root = s?.is_root === true;
      setIsRoot(root);
      if (!root) setSection((cur) => (INSTANCE_ONLY.has(cur) ? "users" : cur));
    });
  }, []);

  const auth = useStoreState(authStore);
  const [section, setSection] = useState<Section>(sectionFromPath);

  const go = (s: Section): void => {
    setSection(s);
    window.history.replaceState(null, "", "/admin/" + s);
  };

  return (
    <div className="admin-app">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <span className="admin-brand-logo"><Logo width={24} /></span>
          <div className="admin-brand-text">
            <div className="admin-brand-name">Outcome Admin</div>
            <div className="admin-brand-sub">{t("admin.adminConsole")}</div>
          </div>
        </div>
        <nav className="admin-nav">
          {NAV.map((grp) => ({ ...grp, items: grp.items.filter((it) =>
              isRoot || !INSTANCE_ONLY.has(it.id)) }))
            .filter((grp) => grp.items.length > 0)
            .map((grp) => (
            <div className="admin-nav-group" key={grp.title()}>
              <div className="admin-nav-title">{grp.title()}</div>
              {grp.items.map((it) => (
                <button
                  key={it.id}
                  className={"admin-nav-item" + (section === it.id ? " active" : "")}
                  onClick={() => go(it.id)}
                >
                  <Icon name={it.icon} size={17} />
                  <span>{it.label()}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar-title">
            <h1>{TITLES[section]()}</h1>
            <p>{SUBTITLES[section]()}</p>
          </div>
          <div className="admin-topbar-right">
            <div className="admin-whoami">
              <Icon name="user" size={16} />
              <span>{auth.user?.username ?? "Admin"}</span>
            </div>
            <a className="admin-exit" href="/" title={t("admin.backToApp")}>
              <Icon name="log-out" size={18} />
            </a>
          </div>
        </header>

        <main className="admin-body">
          <div className="admin-section">
            {section === "dashboard" && <AdminDashboard />}
            {section === "logs" && <AdminLogsPanel />}
            {section === "audit" && <AdminAuditPanel />}
            {section === "users" && <AdminUsersPanel />}
            {section === "servers" && <AdminServersPanel />}
            {section === "roles" && <RolesPanel />}
            {section === "invites" && <AdminInvitesPanel />}
            {section === "bugs" && <AdminBugsPanel />}
            {section === "reports" && <AdminReportsPanel />}
            {section === "server" && <ServerSettingsPanel />}
          </div>
        </main>
      </div>
      {/* The console's own toasts: the app's are mounted by MainPage, which /admin is not. */}
      <Toast />
    </div>
  );
}

/** Shown when a non-owner hits /admin directly. */
export function AdminDenied() {
  return (
    <div className="admin-denied">
      <h1>{t("admin.accessDeniedTitle")}</h1>
      <p>{t("admin.accessDeniedBody")}</p>
      <a className="btn-primary" href="/">{t("admin.backToApp")}</a>
    </div>
  );
}
