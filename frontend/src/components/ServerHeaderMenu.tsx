import { useState, useEffect, useRef } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { openModal, setTransientError } from "@stores/ui.store";
import { confirm } from "@components/ConfirmDialog";
import { serversStore, getActiveServerId } from "@stores/servers.store";
import { loadServers, switchServer } from "@lib/session";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Icon } from "@lib/icons";
import { ServerSettingsModal } from "@components/ServerSettingsModal";

interface Props {
  serverName: string;
  onlineCount: number;
  /** Can invite people to this server (global mod+ or owner of the active server). */
  canInvite: boolean;
  /** Can create channels here (global admin or owner of the active server). */
  canCreateChannel: boolean;
  /** Can delete the active server (owner of it, or global owner). */
  canDeleteServer: boolean;
  /** Can open in-app Server Settings (owner of the active server or a server-admin). */
  canManageServer: boolean;
  /** Can open the INSTANCE admin console (global owner only). */
  isGlobalAdmin: boolean;
  /** Opens the create-channel modal owned by the Sidebar. */
  onCreateChannel: () => void;
}

/** Discord-style server header: click to open a dropdown with server actions. */
export function ServerHeaderMenu({ serverName, onlineCount, canInvite, canCreateChannel, canDeleteServer, canManageServer, isGlobalAdmin, onCreateChannel }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showVis, setShowVis] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Defer attaching so the opening click doesn't immediately close the menu.
    const onDoc = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onEsc);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const run = (fn: () => void) => { setOpen(false); fn(); };

  async function deleteServer() {
    setOpen(false);
    if (!canDeleteServer) return;
    if (!(await confirm({ message: t("server.deleteConfirm", { name: serverName }), danger: true, highlight: serverName }))) return;
    const id = getActiveServerId();
    setBusy(true);
    try {
      await api.deleteServer(id);
      await loadServers();
      const remaining = serversStore.select((s) => s.servers);
      if (remaining.length > 0) switchServer(remaining[0]!.id);
      else window.location.reload();
    } catch (err) {
      setTransientError(err instanceof Error ? err.message : t("server.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  const anyActions = canInvite || isGlobalAdmin || canManageServer || canCreateChannel || canDeleteServer;

  return (
    <div className="unified-sidebar-header server-header" ref={ref}>
      <button
        className={"server-header-btn" + (open ? " open" : "")}
        onClick={() => anyActions && setOpen((v) => !v)}
        disabled={busy || !anyActions}
      >
        <div className="server-header-text">
          <div className="server-name">{serverName}</div>
          <div className="server-online">{t("sidebar.onlineCount", { count: onlineCount })}</div>
        </div>
        {anyActions && <Icon name={open ? "x" : "chevron-down"} size={18} />}
      </button>

      {open && (
        <div className="server-dropdown" role="menu">
          {canInvite && (
            <button className="server-dropdown-item accent" role="menuitem" onClick={() => run(() => openModal("invites"))}>
              <span>{t("server.invitePeople")}</span>
              <Icon name="user-plus" size={16} />
            </button>
          )}
          {canManageServer && (
            <button className="server-dropdown-item" role="menuitem" onClick={() => run(() => setShowSettings(true))}>
              <span>{t("server.settings")}</span>
              <Icon name="settings" size={16} />
            </button>
          )}
          {canInvite && (
            <button className="server-dropdown-item" role="menuitem" onClick={() => run(() => openModal("guestAccess"))}>
              <span>{t("server.guestAccess")}</span>
              <Icon name="external-link" size={16} />
            </button>
          )}
          {canCreateChannel && (
            <button className="server-dropdown-item" role="menuitem" onClick={() => run(onCreateChannel)}>
              <span>{t("server.createChannel")}</span>
              <Icon name="plus" size={16} />
            </button>
          )}
          {isGlobalAdmin && (
            <>
              <div className="server-dropdown-sep" />
              <button className="server-dropdown-item" role="menuitem" onClick={() => run(() => { window.location.href = "/admin"; })}>
                <span>{t("server.adminConsole")}</span>
                <Icon name="shield" size={16} />
              </button>
            </>
          )}
          {canDeleteServer && (
            <>
              <button className="server-dropdown-item" role="menuitem" onClick={() => run(() => setShowVis(true))}>
                <span>{t("server.visibility")}</span>
                <Icon name="signal" size={16} />
              </button>
              <div className="server-dropdown-sep" />
              <button className="server-dropdown-item danger" role="menuitem" onClick={() => void deleteServer()}>
                <span>{t("server.delete")}</span>
                <Icon name="trash-2" size={16} />
              </button>
            </>
          )}
        </div>
      )}

      {showVis && <ServerVisibilityModal serverId={getActiveServerId()} name={serverName} onClose={() => setShowVis(false)} />}
      {showSettings && <ServerSettingsModal serverId={getActiveServerId()} canDelete={canDeleteServer} canModerate={canManageServer} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/** Owner-only: toggle whether the server shows up in Explore + set its blurb. */
function ServerVisibilityModal({ serverId, name, onClose }: { serverId: number; name: string; onClose: () => void }) {
  const [isPublic, setIsPublic] = useState(false);
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    api.getServerVisibility(serverId, c.signal)
      .then((v) => { if (!c.signal.aborted) { setIsPublic(v.is_public); setDesc(v.description); setLoading(false); } })
      .catch(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
  }, [serverId]);

  const save = (): void => {
    setBusy(true);
    void api.setServerVisibility(serverId, isPublic, desc)
      .then(onClose)
      .catch((e: unknown) => setTransientError(e instanceof Error ? e.message : t("server.visibilityFailed")))
      .finally(() => setBusy(false));
  };

  return (
    <ModalPortal>
      <div className="settings-overlay open" onClick={onClose}>
        <div className="vis-modal" onClick={(e) => e.stopPropagation()}>
          <h2>{t("server.visibilityTitle")}</h2>
          <p className="vis-sub">{name}</p>
          {loading ? <div className="dm-empty">{t("admin.loading")}</div> : (
            <>
              <label className="vis-toggle-row">
                <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
                <div>
                  <div className="vis-toggle-label">{t("server.makePublic")}</div>
                  <div className="vis-toggle-desc">{t("server.makePublicDesc")}</div>
                </div>
              </label>
              <label className="vis-field-label">{t("server.description")}</label>
              <textarea
                className="form-input" rows={3} maxLength={280}
                placeholder={t("server.descriptionPlaceholder")}
                value={desc} onChange={(e) => setDesc(e.target.value)}
              />
              <div className="vis-actions">
                <button className="input-btn" onClick={onClose}>{t("rail.cancel")}</button>
                <button className="btn-primary" disabled={busy} onClick={save}>{t("common.save")}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
