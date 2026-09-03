/**
 * Server Settings — a per-server management surface shown IN the app (not the instance
 * /admin console). Available to the server owner or a server-admin. Tabs: Overview
 * (rename / visibility / delete), Channels, Members & Roles, Invites. Everything is scoped
 * to the active server via the normal X-Server-Id request context.
 */
import { useEffect, useState } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { confirm } from "@components/ConfirmDialog";
import { useStoreState } from "@lib/useStore";
import { membersStore } from "@stores/members.store";
import { channelsStore } from "@stores/channels.store";
import { serversStore } from "@stores/servers.store";
import { setTransientError } from "@stores/ui.store";
import { assetUrl } from "@lib/serverHost";
import { loadServers, switchServer } from "@lib/session";
import { api } from "@lib/services";
import { roleColor } from "@lib/format";
import { t } from "@lib/i18n";
import { Icon } from "@lib/icons";
import { Avatar } from "@components/Avatar";
import { InviteManager } from "@components/admin/InviteManager";
import { AdminReportsPanel } from "@components/admin/AdminReportsPanel";

type Tab = "overview" | "channels" | "members" | "invites" | "reports";
const TABS: { id: Tab; icon: string; label: () => string }[] = [
  { id: "overview", icon: "settings", label: () => t("srvset.overview") },
  { id: "channels", icon: "hash", label: () => t("srvset.channels") },
  { id: "members", icon: "users", label: () => t("srvset.members") },
  { id: "invites", icon: "user-plus", label: () => t("srvset.invites") },
];
// Complaints about THIS server's channels. Shown only to whoever may act on them, because a
// queue you can read and not answer is worse than not having one.
const REPORTS_TAB = { id: "reports" as Tab, icon: "flag", label: () => t("srvset.reports") };

export function ServerSettingsModal({ serverId, canDelete, canModerate, onClose }: { serverId: number; canDelete: boolean; canModerate: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  // SUBSCRIBED, not sampled. `select` reads once: uploading an icon refreshed the store and
  // the rail redrew, while the panel doing the uploading went on showing the old one — the one
  // place where seeing the change matters most.
  const server = useStoreState(serversStore).servers.find((s) => s.id === serverId);

  return (
    <ModalPortal>
      <div className="settings-overlay open" onClick={onClose}>
        <div className="srvset-modal" onClick={(e) => e.stopPropagation()}>
          <aside className="srvset-nav">
            <div className="srvset-nav-title">{server?.name ?? t("srvset.title")}</div>
            {[...TABS, ...(canModerate ? [REPORTS_TAB] : [])].map((it) => (
              <button key={it.id} className={"srvset-nav-item" + (tab === it.id ? " active" : "")} onClick={() => setTab(it.id)}>
                <Icon name={it.icon as never} size={16} /> <span>{it.label()}</span>
              </button>
            ))}
            <button className="srvset-close" onClick={onClose}><Icon name="x" size={16} /> {t("rail.cancel")}</button>
          </aside>
          <div className="srvset-body">
            {tab === "overview" && <OverviewTab serverId={serverId} canDelete={canDelete} onClose={onClose} />}
            {tab === "channels" && <ChannelsTab />}
            {tab === "members" && <MembersTab serverId={serverId} />}
            {tab === "invites" && <div className="srvset-pane"><InviteManager /></div>}
            {tab === "reports" && <div className="srvset-pane"><AdminReportsPanel scope="server" /></div>}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function OverviewTab({ serverId, canDelete, onClose }: { serverId: number; canDelete: boolean; onClose: () => void }) {
  // SUBSCRIBED, not sampled. `select` reads once: uploading an icon refreshed the store and
  // the rail redrew, while the panel doing the uploading went on showing the old one — the one
  // place where seeing the change matters most.
  const server = useStoreState(serversStore).servers.find((s) => s.id === serverId);
  const [name, setName] = useState(server?.name ?? "");
  const [isPublic, setIsPublic] = useState(false);
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    api.getServerVisibility(serverId, c.signal)
      .then((v) => { if (!c.signal.aborted) { setIsPublic(v.is_public); setDesc(v.description); } })
      .catch(() => {});
    return () => c.abort();
  }, [serverId]);

  async function saveName() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await api.renameServer(serverId, name.trim()); await loadServers(); }
    catch (e) { setTransientError(e instanceof Error ? e.message : t("srvset.saveFailed")); }
    finally { setBusy(false); }
  }
  /** Upload a picture and hang it on the server. Empty string removes it. */
  async function saveIcon(file: File | null) {
    if (busy) return;
    setBusy(true);
    try {
      const url = file ? (await api.uploadFile(file)).url : "";
      await api.renameServer(serverId, (server?.name ?? name).trim(), url);
      await loadServers();
    } catch (e) { setTransientError(e instanceof Error ? e.message : t("srvset.saveFailed")); }
    finally { setBusy(false); }
  }
  async function saveVisibility() {
    setBusy(true);
    try { await api.setServerVisibility(serverId, isPublic, desc); }
    catch (e) { setTransientError(e instanceof Error ? e.message : t("server.visibilityFailed")); }
    finally { setBusy(false); }
  }
  async function del() {
    if (!(await confirm({ message: t("server.deleteConfirm", { name: server?.name ?? "" }), danger: true, highlight: server?.name ?? "" }))) return;
    setBusy(true);
    try {
      await api.deleteServer(serverId);
      await loadServers();
      const rest = serversStore.select((s) => s.servers);
      onClose();
      if (rest.length > 0) switchServer(rest[0]!.id); else window.location.reload();
    } catch (e) { setTransientError(e instanceof Error ? e.message : t("server.deleteFailed")); setBusy(false); }
  }

  return (
    <div className="srvset-pane">
      <h2 className="srvset-h2">{t("srvset.overview")}</h2>
      <div className="form-group">
        <label className="form-label">{t("srvset.serverIcon")}</label>
        <div className="srvset-row" style={{ alignItems: "center" }}>
          {server?.icon
            ? <img src={assetUrl(server.icon)} alt="" width={64} height={64}
                style={{ borderRadius: 16, objectFit: "cover", flexShrink: 0 }} />
            : <div style={{
                width: 64, height: 64, borderRadius: 16, flexShrink: 0,
                display: "grid", placeItems: "center",
                background: "var(--bg-secondary)", color: "var(--text-muted)", fontWeight: 700,
              }}>{(server?.name ?? "?").slice(0, 2).toUpperCase()}</div>}
          <label className="btn-primary" style={{ width: "auto", cursor: "pointer" }}>
            {t("srvset.iconUpload")}
            <input type="file" accept="image/*" hidden disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; void saveIcon(f); }} />
          </label>
          {server?.icon && (
            <button className="ac-btn" style={{ width: "auto" }} disabled={busy}
              onClick={() => void saveIcon(null)}>{t("srvset.iconRemove")}</button>
          )}
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">{t("srvset.serverName")}</label>
        <div className="srvset-row">
          <input className="form-input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary" disabled={busy || name.trim() === server?.name} onClick={saveName} style={{ width: "auto" }}>{t("common.save")}</button>
        </div>
      </div>

      <div className="srvset-section">
        <label className="vis-toggle-row" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          <div>
            <div className="vis-toggle-label">{t("server.makePublic")}</div>
            <div className="vis-toggle-desc">{t("server.makePublicDesc")}</div>
          </div>
        </label>
        <label className="form-label">{t("server.description")}</label>
        <textarea className="form-input" rows={3} maxLength={280} placeholder={t("server.descriptionPlaceholder")} value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div style={{ marginTop: 10 }}>
          <button className="btn-primary" disabled={busy} onClick={saveVisibility} style={{ width: "auto" }}>{t("common.save")}</button>
        </div>
      </div>

      {canDelete && (
        <div className="srvset-danger">
          <div className="srvset-danger-title">{t("srvset.dangerZone")}</div>
          <div className="srvset-danger-row">
            <div><div className="vis-toggle-label">{t("server.delete")}</div><div className="vis-toggle-desc">{t("srvset.deleteDesc")}</div></div>
            <button className="ac-btn account-delete-btn" disabled={busy} onClick={del}>{t("server.delete")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelsTab() {
  const ch = useStoreState(channelsStore);
  const [name, setName] = useState("");
  const [type, setType] = useState<"text" | "voice">("text");
  const [busy, setBusy] = useState(false);
  const channels = [...ch.channels.values()].filter((c) => c.type !== "dm");

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await api.adminCreateChannel({ name: name.trim(), type, category: "" }); setName(""); }
    catch (e) { setTransientError(e instanceof Error ? e.message : t("srvset.channelFailed")); }
    finally { setBusy(false); }
  }
  async function remove(id: number, nm: string) {
    if (!(await confirm({ message: t("sidebar.deleteChannelConfirm", { name: nm }), danger: true, highlight: nm }))) return;
    try { await api.adminDeleteChannel(id); }
    catch (e) { setTransientError(e instanceof Error ? e.message : t("sidebar.deleteChannelFailed")); }
  }

  return (
    <div className="srvset-pane">
      <h2 className="srvset-h2">{t("srvset.channels")}</h2>
      <div className="srvset-row" style={{ marginBottom: 16 }}>
        <input className="form-input" placeholder={t("srvset.newChannelName")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
        <select className="bug-status-select" value={type} onChange={(e) => setType(e.target.value as "text" | "voice")}>
          <option value="text">{t("srvset.textChannel")}</option>
          <option value="voice">{t("srvset.voiceChannel")}</option>
        </select>
        <button className="btn-primary" disabled={busy} onClick={create} style={{ width: "auto" }}><Icon name="plus" size={15} /></button>
      </div>
      <div className="srvset-list">
        {channels.map((c) => (
          <div className="srvset-list-row" key={c.id}>
            <span className="srvset-ch-name"><Icon name={c.type === "voice" ? "volume-2" : "hash"} size={15} /> {c.name}</span>
            <button className="ac-btn account-delete-btn" onClick={() => remove(c.id, c.name)}>{t("admin.delete")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MembersTab({ serverId }: { serverId: number }) {
  const m = useStoreState(membersStore);
  const roles = channelsStore.getState().roles;
  const assignable = roles.filter((r) => r.name.toLowerCase() !== "owner");
  const members = [...m.members.values()].sort((a, b) => a.username.localeCompare(b.username));

  async function setRole(userId: number, roleId: number | null) {
    try { await api.assignServerRole(serverId, userId, roleId); await loadServers(); }
    catch (e) { setTransientError(e instanceof Error ? e.message : t("sidebar.actionFailed")); }
  }
  async function kick(userId: number, name: string) {
    if (!(await confirm({ message: t("srvset.kickConfirm", { name }), danger: true, highlight: name }))) return;
    try { await api.kickServerMember(serverId, userId); }
    catch (e) { setTransientError(e instanceof Error ? e.message : t("sidebar.actionFailed")); }
  }

  return (
    <div className="srvset-pane">
      <h2 className="srvset-h2">{t("srvset.members")} — {members.length}</h2>
      <div className="srvset-list">
        {members.map((mem) => {
          const isOwner = mem.role.toLowerCase() === "owner";
          const curRole = assignable.find((r) => r.name.toLowerCase() === mem.role.toLowerCase());
          return (
            <div className="srvset-list-row" key={mem.id}>
              <span className="srvset-member">
                <Avatar username={mem.username} avatar={mem.avatar} size={28} color={roleColor(mem.role)} />
                <span style={{ color: roleColor(mem.role) }}>{mem.username}</span>
                {isOwner && <span className="srvset-owner-tag">{t("sidebar.role_owner")}</span>}
              </span>
              {!isOwner && (
                <span className="srvset-member-actions">
                  <select
                    className="bug-status-select"
                    value={curRole ? String(curRole.id) : "member"}
                    onChange={(e) => setRole(mem.id, e.target.value === "member" ? null : Number(e.target.value))}
                  >
                    <option value="member">{t("sidebar.role_member")}</option>
                    {assignable.filter((r) => r.name.toLowerCase() !== "member").map((r) => (
                      <option key={r.id} value={String(r.id)}>{r.name}</option>
                    ))}
                  </select>
                  <button className="ac-btn account-delete-btn" onClick={() => kick(mem.id, mem.username)}>{t("sidebar.kick")}</button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
