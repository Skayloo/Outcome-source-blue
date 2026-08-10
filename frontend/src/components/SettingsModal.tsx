import { Component, useEffect, useState, type ReactNode } from "react";
import { useStoreState } from "@lib/useStore";
import { authStore } from "@stores/auth.store";
import { closeSettings } from "@stores/ui.store";
import { logout } from "@lib/session";
import { t } from "@lib/i18n";
import { initials, roleColor } from "@lib/format";
import { AccountTab } from "@components/settings/AccountTab";
import { BlockedTab } from "@components/settings/BlockedTab";
import { VoiceTab } from "@components/settings/VoiceTab";
import { AppearanceTab } from "@components/settings/AppearanceTab";
import { AccessibilityTab } from "@components/settings/AccessibilityTab";
import { NotificationsTab } from "@components/settings/NotificationsTab";
import { KeybindsTab } from "@components/settings/KeybindsTab";
import { TextImagesTab } from "@components/settings/TextImagesTab";
import { AdvancedTab } from "@components/settings/AdvancedTab";
import { LogsTab } from "@components/settings/LogsTab";

type Tab =
  | "account" | "blocked" | "voice" | "appearance" | "accessibility" | "notifications"
  | "keybinds" | "text" | "advanced" | "logs";

interface NavItem { id: Tab; labelKey: string; catKey: string }

// Labels/categories resolved through t() at render time (see `cats`/render below).
const NAV: NavItem[] = [
  { id: "account", labelKey: "settings.navAccount", catKey: "settings.catUser" },
  { id: "blocked", labelKey: "settings.navBlocked", catKey: "settings.catUser" },
  { id: "voice", labelKey: "settings.navVoice", catKey: "settings.catUser" },
  { id: "appearance", labelKey: "settings.navAppearance", catKey: "settings.catUser" },
  { id: "accessibility", labelKey: "settings.navAccessibility", catKey: "settings.catUser" },
  { id: "notifications", labelKey: "settings.navNotifications", catKey: "settings.catUser" },
  { id: "keybinds", labelKey: "settings.navKeybinds", catKey: "settings.catUser" },
  { id: "text", labelKey: "settings.navTextImages", catKey: "settings.catApp" },
  { id: "advanced", labelKey: "settings.navAdvanced", catKey: "settings.catApp" },
  { id: "logs", labelKey: "settings.navLogs", catKey: "settings.catApp" },
];

const TITLE_KEYS: Record<Tab, string> = {
  account: "settings.navAccount", blocked: "settings.navBlocked", voice: "settings.navVoice", appearance: "settings.navAppearance",
  accessibility: "settings.navAccessibility", notifications: "settings.navNotifications", keybinds: "settings.navKeybinds",
  text: "settings.navTextImages", advanced: "settings.navAdvanced", logs: "settings.navLogs",
};

/** Keeps one failing settings tab from unmounting the whole panel. */
class TabBoundary extends Component<{ tab: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) { return { error: err instanceof Error ? err.message : String(err) }; }
  componentDidUpdate(prev: { tab: string }) { if (prev.tab !== this.props.tab && this.state.error) this.setState({ error: null }); }
  render() {
    if (this.state.error) {
      return <div style={{ color: "var(--text-muted)", padding: "24px 0" }}>{t("settings.sectionFailed")}: {this.state.error}</div>;
    }
    return this.props.children;
  }
}

export function SettingsModal() {
  const auth = useStoreState(authStore);
  const [tab, setTab] = useState<Tab>("account");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeSettings(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Group nav items by category key, preserving order.
  const cats: string[] = [];
  for (const n of NAV) if (!cats.includes(n.catKey)) cats.push(n.catKey);

  return (
    <div className="settings-overlay open" onClick={closeSettings}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <div className="settings-sidebar-profile">
            <div className="settings-sidebar-avatar" style={{ background: roleColor(auth.user?.role) }}>
              {initials(auth.user?.username ?? "?")}
            </div>
            <div style={{ overflow: "hidden" }}>
              <div className="settings-sidebar-name">{auth.user?.username ?? "—"}</div>
              <div className="settings-sidebar-edit" onClick={() => setTab("account")}>{t("settings.editProfile")}</div>
            </div>
          </div>

          {cats.map((cat) => (
            <div key={cat}>
              <div className="settings-cat">{t(cat)}</div>
              {NAV.filter((n) => n.catKey === cat).map((n) => (
                <button
                  key={n.id}
                  className={"settings-nav-item" + (tab === n.id ? " active" : "")}
                  onClick={() => setTab(n.id)}
                >{t(n.labelKey)}</button>
              ))}
            </div>
          ))}

          <div className="settings-sep" />
          <div className="settings-sidebar-logout">
            <button className="settings-nav-item danger" onClick={logout}>{t("settings.logOut")}</button>
          </div>
        </div>

        <div className="settings-content">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h1>{t(TITLE_KEYS[tab])}</h1>
            <button className="settings-close-btn" title={t("settings.closeEsc")} onClick={closeSettings}>✕</button>
          </div>
          <TabBoundary tab={tab}>
            {tab === "account" && <AccountTab />}
            {tab === "blocked" && <BlockedTab />}
            {tab === "voice" && <VoiceTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "accessibility" && <AccessibilityTab />}
            {tab === "notifications" && <NotificationsTab />}
            {tab === "keybinds" && <KeybindsTab />}
            {tab === "text" && <TextImagesTab />}
            {tab === "advanced" && <AdvancedTab />}
            {tab === "logs" && <LogsTab />}
          </TabBoundary>
        </div>
      </div>
    </div>
  );
}
