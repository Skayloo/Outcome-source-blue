import { useState, type CSSProperties } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { useStoreState } from "@lib/useStore";
import { serversStore, setServers, setActiveServer } from "@stores/servers.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { friendsStore } from "@stores/friends.store";
import { voiceStore } from "@stores/voice.store";
import { switchServer } from "@lib/session";
import { api, ws } from "@lib/services";
import {
  uiStore, setTransientError, setSidebarMode, rememberServerChannel, recallServerChannel,
  rememberDmChannel, recallDmChannel,
} from "@stores/ui.store";
import { Icon } from "@lib/icons";
import { Logo } from "@components/Logo";
import { ExploreModal } from "@components/ExploreModal";
import { BugReportModal } from "@components/BugReportModal";
import { initials } from "@lib/format";
import { t } from "@lib/i18n";

/** The seeded primary server uses the brand mark instead of initials. */
const PRIMARY_SERVER_ID = 1;

/**
 * Discord-style server rail. A Home (DM) button sits on top — selecting it swaps the
 * sidebar to the Direct Messages view; below it, one icon per server the user belongs
 * to, highlighting the active one. The "+" opens a create-server modal.
 */
export function ServerRail() {
  const { servers, activeServerId } = useStoreState(serversStore);
  const ui = useStoreState(uiStore);
  const dm = useStoreState(dmStore);
  const friends = useStoreState(friendsStore);
  const voice = useStoreState(voiceStore);
  const [showCreate, setShowCreate] = useState(false);
  const [showExplore, setShowExplore] = useState(false);
  const [showBug, setShowBug] = useState(false);

  const homeActive = ui.sidebarMode === "dms";
  const dmUnread = dm.channels.reduce((sum, c) => sum + c.unreadCount, 0) + friends.incoming.length;

  function goHome(): void {
    if (homeActive) return;
    // Remember the server channel so returning to this server restores it.
    const st = channelsStore.getState();
    if (st.activeChannelId !== null && st.channels.has(st.activeChannelId)) {
      rememberServerChannel(st.activeChannelId);
      setActiveChannel(null);
    }
    setSidebarMode("dms");
    // Re-open the conversation they were reading last time they were here. Without this the
    // pane comes up empty and the DM has to be picked out of the list again on every trip.
    const lastDm = recallDmChannel();
    if (lastDm !== null && dmStore.getState().channels.some((d) => d.channelId === lastDm)) {
      setActiveChannel(lastDm);
    }
  }

  function goServer(id: number): void {
    // Leaving the Home view: note which DM was open, so coming back returns to it.
    const before = channelsStore.getState().activeChannelId;
    if (homeActive && before !== null) rememberDmChannel(before);
    setSidebarMode("channels");
    if (id !== activeServerId) {
      switchServer(id); // clears channel; the scoped READY auto-selects
      return;
    }
    // Same server as before Home: restore the remembered channel (or first text channel).
    const st = channelsStore.getState();
    if (st.activeChannelId !== null && st.channels.has(st.activeChannelId)) return;
    const recalled = recallServerChannel();
    const restore = recalled !== null && st.channels.has(recalled)
      ? recalled
      : [...st.channels.values()].find((c) => c.type === "text")?.id ?? null;
    setActiveChannel(restore);
  }

  return (
    <div className="server-rail">
      <div
        className={`rail-server rail-home${homeActive ? " active" : ""}`}
        title={t("rail.home")}
        onClick={goHome}
      >
        <Icon name="message-circle" size={24} />
        {dmUnread > 0 && <span className="rail-badge">{dmUnread > 99 ? "99+" : dmUnread}</span>}
      </div>
      <div className="rail-sep" />
      {servers.map((server) => {
        const active = !homeActive && server.id === activeServerId;
        return (
          <div
            key={server.id}
            className={`rail-server${active ? " active" : ""}`}
            title={server.name}
            onClick={() => goServer(server.id)}
          >
            {server.id === PRIMARY_SERVER_ID
              ? <span className="rail-logo-wrap"><Logo width={26} /></span>
              : initials(server.name)}
            {voice.connectedServerId === server.id && (
              <span className="rail-voice-dot" title={t("voice.voiceConnected")} />
            )}
          </div>
        );
      })}
      <div className="rail-sep" />
      <button
        className="rail-btn"
        title={t("rail.createServer")}
        onClick={() => setShowCreate(true)}
      ><Icon name="plus" size={22} /></button>
      <button
        className="rail-btn"
        title={t("rail.explore")}
        onClick={() => setShowExplore(true)}
      ><Icon name="signal" size={20} /></button>
      <button
        className="rail-btn rail-btn-bug"
        title={t("rail.bugReport")}
        onClick={() => setShowBug(true)}
      ><Icon name="bug" size={20} /></button>

      {showCreate && <CreateServerModal onClose={() => setShowCreate(false)} />}
      {showExplore && <ExploreModal onClose={() => setShowExplore(false)} />}
      {showBug && <BugReportModal onClose={() => setShowBug(false)} />}
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.6)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};
const modal: CSSProperties = {
  width: 440, maxWidth: "92vw", background: "var(--bg-primary)",
  border: "1px solid var(--border)", borderRadius: 12, padding: 24, color: "var(--text-normal)",
};

/** Inline modal: create a new server, OR join an existing one with an invite code.
 *  Either path adds it to the rail, switches to it, and reconnects for a scoped READY. */
export function CreateServerModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  function enter(server: { id: number }): void {
    setServers([...serversStore.select((s) => s.servers), server as never]);
    setSidebarMode("channels");
    setActiveServer(server.id);
    ws.reconnect(); // fresh scoped READY for the new tenant
    onClose();
  }

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { enter(await api.createServer(name.trim())); }
    catch (e) { setTransientError(e instanceof Error ? e.message : t("rail.createFailed")); setBusy(false); }
  }
  async function join() {
    if (!code.trim() || busy) return;
    setBusy(true);
    try { enter(await api.joinServer(code.trim())); }
    catch (e) { setTransientError(e instanceof Error ? e.message : t("rail.joinFailed")); setBusy(false); }
  }

  return (
    <ModalPortal>
      <div style={overlay} onClick={onClose}>
        <div style={modal} onClick={(e) => e.stopPropagation()}>
          <div className="srv-modal-tabs">
            <button className={"srv-modal-tab" + (tab === "create" ? " active" : "")} onClick={() => setTab("create")}>{t("rail.createTab")}</button>
            <button className={"srv-modal-tab" + (tab === "join" ? " active" : "")} onClick={() => setTab("join")}>{t("rail.joinTab")}</button>
          </div>
          {tab === "create" ? (
            <div className="form-group">
              <label className="form-label">{t("rail.serverName")}</label>
              <input
                className="form-input" autoFocus placeholder={t("rail.serverNamePlaceholder")}
                value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") create(); }}
              />
            </div>
          ) : (
            <div className="form-group">
              <label className="form-label">{t("rail.inviteCode")}</label>
              <input
                className="form-input" autoFocus placeholder={t("rail.inviteCodePlaceholder")}
                value={code} onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") join(); }}
              />
              <div className="form-hint">{t("rail.joinHint")}</div>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button className="input-btn" onClick={onClose} style={{ width: "auto", padding: "0 14px" }}>
              {t("rail.cancel")}
            </button>
            {tab === "create" ? (
              <button className="btn-primary" disabled={busy} onClick={create} style={{ width: "auto" }}>{t("rail.create")}</button>
            ) : (
              <button className="btn-primary" disabled={busy} onClick={join} style={{ width: "auto" }}>{t("rail.join")}</button>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
