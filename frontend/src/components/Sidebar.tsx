import { useState } from "react";
import { useStoreState } from "@lib/useStore";
import { confirm } from "@components/ConfirmDialog";
import { authStore } from "@stores/auth.store";
import { channelsStore, getChannelsByCategory, setActiveChannel, clearUnread, type Channel } from "@stores/channels.store";
import { mutesStore, toggleChannelMute } from "@stores/mutes.store";
import { ContextMenu, type MenuEntry } from "@components/ContextMenu";
import { membersStore } from "@stores/members.store";
import { voiceStore, getChannelVoiceUsers } from "@stores/voice.store";
import { serversStore, getActiveServerId } from "@stores/servers.store";
import { setTransientError, openModal, uiStore, toggleCategory, isCategoryCollapsed } from "@stores/ui.store";
import { closeDrawer } from "@stores/mobile.store";
import { api } from "@lib/services";
import { joinVoice } from "@lib/voice";
import { Avatar } from "@components/Avatar";
import { t } from "@lib/i18n";
import { Icon } from "@lib/icons";
import { openInSplit } from "@stores/panes.store";
import { UserBar } from "@components/UserBar";
import { PlaybackBar } from "@components/PlaybackBar";
import { InboxView } from "@components/InboxView";
import { VoiceUserMenu } from "@components/VoiceUserMenu";
import { CreateChannelModal } from "@components/CreateChannelModal";
import { ServerHeaderMenu } from "@components/ServerHeaderMenu";

export function Sidebar() {
  useStoreState(channelsStore);
  useStoreState(voiceStore);
  const ui = useStoreState(uiStore);
  useStoreState(serversStore);
  const auth = useStoreState(authStore);
  const members = useStoreState(membersStore);
  const [vMenu, setVMenu] = useState<{ userId: number; x: number; y: number } | null>(null);
  const [chMenu, setChMenu] = useState<{ ch: Channel; x: number; y: number } | null>(null);
  const mutes = useStoreState(mutesStore);

  const byCategory = getChannelsByCategory();
  const activeId = channelsStore.getState().activeChannelId;
  const onlineCount = [...members.members.values()].filter((m) => m.status !== "offline").length;
  const role = (auth.user?.role ?? "").toLowerCase();
  const isGlobalAdmin = role === "owner";
  const canManageGlobal = ["owner", "admin"].includes(role);
  // Per-server ownership: the creator is an admin of the server they own (active tenant).
  const activeServerId = getActiveServerId();
  const myId = auth.user?.id ?? -1;
  const activeServer = serversStore.select((s) => s.servers).find((s) => s.id === activeServerId);
  // Header shows the ACTIVE tenant server's name (not auth.serverName, which is the global instance name).
  const serverName = activeServer?.name ?? auth.serverName ?? "Outcome";
  const isServerOwner = activeServer?.owner_id === myId;
  const canManage = canManageGlobal || isServerOwner;
  const canInvite = ["owner", "admin", "moderator"].includes(role) || isServerOwner;
  const canDeleteServer = isGlobalAdmin || isServerOwner;

  // undefined = modal closed; null|string = open for that category
  const [createCat, setCreateCat] = useState<string | null | undefined>(undefined);

  async function deleteChannel(id: number, name: string) {
    if (!canManage) return;
    if (!(await confirm({ message: t("sidebar.deleteChannelConfirm", { name }), danger: true, highlight: name }))) return;
    try { await api.adminDeleteChannel(id); }
    catch (err) { setTransientError(err instanceof Error ? err.message : t("sidebar.deleteChannelFailed")); }
  }

  /** The channel-row right-click menu: personal actions first, management last. */
  function channelMenuItems(ch: Channel): MenuEntry[] {
    const items: MenuEntry[] = [];
    if (ch.type !== "voice") {
      const muted = mutes.muted.has(ch.id);
      items.push(
        { label: t("ctx.markRead"), icon: <Icon name="check" size={15} />, onClick: () => clearUnread(ch.id) },
        // Split view. Offered on wide screens only — two conversations side by side on a phone
        // would leave neither of them readable.
        ...(window.innerWidth > 1100
          ? [{ label: "Открыть справа", icon: <Icon name="chevron-right" size={15} />, onClick: () => openInSplit(ch.id) }]
          : []),
        {
          label: muted ? t("ctx.unmuteChat") : t("ctx.muteChat"),
          icon: <Icon name={muted ? "bell" : "bell-off"} size={15} />,
          onClick: () => toggleChannelMute(ch.id),
        },
      );
    }
    if (canManage) {
      if (items.length > 0) items.push({ separator: true });
      items.push({
        label: t("ctx.deleteChannel"), danger: true, icon: <Icon name="trash-2" size={15} />,
        onClick: () => { void deleteChannel(ch.id, ch.name); },
      });
    }
    return items;
  }

  // ── Home view → the unified Inbox (activity-first: unread DMs + channels, then all DMs) ──
  if (ui.sidebarMode === "dms") {
    return (
      <div className="unified-sidebar inbox-view">
        <InboxView />
        <PlaybackBar />
        <UserBar />
      </div>
    );
  }

  return (
    <div className="unified-sidebar">
      <ServerHeaderMenu
        serverName={serverName}
        onlineCount={onlineCount}
        canInvite={canInvite}
        canCreateChannel={canManage}
        canDeleteServer={canDeleteServer}
        canManageServer={canManage}
        isGlobalAdmin={isGlobalAdmin}
        onCreateChannel={() => setCreateCat(null)}
      />

      <button className="nav-search" onClick={() => openModal("command")}>
        <Icon name="arrow-right" size={14} />
        <span>{t("cmd.search")}</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="channel-list">
        {[...byCategory.entries()].map(([category, channels]) => {
          const catKey = category ?? "_uncategorized";
          const collapsed = isCategoryCollapsed(catKey);
          return (
          <div key={catKey}>
            <div className="category">
              <span className="category-name category-toggle" onClick={() => toggleCategory(catKey)}>
                <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
                {category ?? t("sidebar.channels")}
              </span>
              {canManage && (
                <span className="category-add-btn" title={t("sidebar.createChannel")} onClick={() => setCreateCat(category)}>+</span>
              )}
            </div>
            <div className="category-channels" style={collapsed ? { display: "none" } : undefined}>
              {channels.map((ch) => {
                const vUsers = ch.type === "voice" ? (getChannelVoiceUsers(ch.id) ?? []) : [];
                // The voice channel the user is CURRENTLY connected to (Discord-style green highlight).
                const connectedHere = ch.type === "voice" && voiceStore.getState().currentChannelId === ch.id;
                return (
                  <div key={ch.id}>
                    <div
                      className={
                        "channel-item channel-draggable" +
                        (ch.id === activeId ? " active" : "") +
                        (ch.unreadCount > 0 ? " unread" : "") +
                        (connectedHere ? " voice-connected" : "")
                      }
                      onClick={() => { if (ch.type === "voice") joinVoice(ch.id); setActiveChannel(ch.id); closeDrawer(); }}
                      onContextMenu={(e) => { e.preventDefault(); setChMenu({ ch, x: e.clientX, y: e.clientY }); }}
                    >
                      <span className="ch-icon">
                        {ch.type === "voice" ? <Icon name="volume-2" size={18} />
                          : ch.type === "announcement" ? <Icon name="bell" size={18} />
                          : ch.type === "dm" ? "@" : "#"}
                      </span>
                      <span className="ch-name">{ch.name}</span>
                      {mutes.muted.has(ch.id) && <span className="ch-muted"><Icon name="bell-off" size={12} /></span>}
                      {connectedHere && <span className="ch-live-dot" title={t("voice.voiceConnected")} />}
                      {ch.unreadCount > 0 && <span className="unread-badge">{ch.unreadCount}</span>}
                    </div>
                    {vUsers.length > 0 && (
                      <div className="voice-users-list">
                        {vUsers.map((u) => (
                          <div
                            className={"voice-user-item" + (u.speaking ? " speaking" : "")}
                            key={u.userId}
                            title={u.userId === auth.user?.id ? undefined : t("ctx.userVolume")}
                            // Click a participant → volume/mute popover (Discord-style, discoverable).
                            onClick={(e) => { e.stopPropagation(); setVMenu({ userId: u.userId, x: e.clientX, y: e.clientY }); }}
                            onContextMenu={(e) => { e.preventDefault(); setVMenu({ userId: u.userId, x: e.clientX, y: e.clientY }); }}
                          >
                            <Avatar username={u.username} avatar={u.userId === auth.user?.id ? (auth.user?.avatar ?? null) : u.avatar} size={20} color="#5865f2" className="vu-avatar" />
                            <span className="vu-name">{u.username}</span>
                            {u.muted && <span className="vu-muted"><Icon name="mic-off" size={12} /></span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          );
        })}
      </div>

      <PlaybackBar />
      <UserBar />

      {createCat !== undefined && (
        <CreateChannelModal category={createCat} onClose={() => setCreateCat(undefined)} />
      )}
      {vMenu && (
        <VoiceUserMenu userId={vMenu.userId} x={vMenu.x} y={vMenu.y} onClose={() => setVMenu(null)} />
      )}
      {chMenu && channelMenuItems(chMenu.ch).length > 0 && (
        <ContextMenu x={chMenu.x} y={chMenu.y} items={channelMenuItems(chMenu.ch)} onClose={() => setChMenu(null)} />
      )}
    </div>
  );
}
