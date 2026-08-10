import { useState } from "react";
import { useStoreState } from "@lib/useStore";
import { dmStore, clearDmUnread, removeDmChannel, type DmChannel } from "@stores/dm.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { serversStore, getActiveServerId } from "@stores/servers.store";
import { friendsStore, dropFriend } from "@stores/friends.store";
import { mutesStore, toggleChannelMute } from "@stores/mutes.store";
import { openModal, setSidebarMode } from "@stores/ui.store";
import { closeDrawer } from "@stores/mobile.store";
import { Avatar } from "@components/Avatar";
import { ContextMenu, type MenuEntry } from "@components/ContextMenu";
import { confirm } from "@components/ConfirmDialog";
import { api } from "@lib/services";
import { startCall } from "@lib/call";
import { Icon } from "@lib/icons";
import { t, getLocale } from "@lib/i18n";

/** Locale-aware, compact "2 min ago" / "yesterday" for an ISO timestamp. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.round((then - Date.now()) / 1000); // negative = past
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto", style: "narrow" });
  const abs = Math.abs(sec);
  if (abs < 60) return rtf.format(Math.round(sec), "second");
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
  if (abs < 604800) return rtf.format(Math.round(sec / 86400), "day");
  return new Date(then).toLocaleDateString(getLocale());
}

/**
 * Unified Inbox — the reimagined Home. Instead of a flat DM list, this is an activity-first
 * conversation inbox: a "Needs attention" band pulls together everything unread (direct
 * messages AND channels that got new activity while you were elsewhere) so what's new lives in
 * ONE place, then all your direct conversations below. Empty = a calm "all caught up" state.
 *
 * NOTE: channel unread here is what the client learned live this session (server READY ships
 * unread_count=0 today). A true cross-ALL-servers inbox needs a backend activity endpoint
 * (wire ReadState → READY / GET /inbox) — tracked as the next step.
 */
export function InboxView() {
  useStoreState(dmStore);
  useStoreState(channelsStore);
  useStoreState(serversStore);
  const friends = useStoreState(friendsStore);
  const mutes = useStoreState(mutesStore);
  const [menu, setMenu] = useState<{ x: number; y: number; dm: DmChannel } | null>(null);

  const dms = [...dmStore.getState().channels].sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
  );
  const unreadDms = dms.filter((d) => d.unreadCount > 0);

  const activeServerId = getActiveServerId();
  const activeServerName =
    serversStore.select((s) => s.servers).find((s) => s.id === activeServerId)?.name ?? "";
  const unreadChannels = [...channelsStore.getState().channels.values()]
    .filter((c) => c.type !== "dm" && c.type !== "voice" && c.unreadCount > 0)
    .sort((a, b) => (b.lastMessageId ?? 0) - (a.lastMessageId ?? 0));

  const incoming = friends.incoming.length;
  const attention = unreadDms.length + unreadChannels.length;

  function openDm(channelId: number): void {
    setActiveChannel(channelId);
    clearDmUnread(channelId);
    closeDrawer();
  }
  function onDmContextMenu(e: React.MouseEvent, dm: DmChannel): void {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, dm });
  }
  /** The Discord-style DM row menu, assembled from actions that already exist elsewhere. */
  function dmMenuItems(d: DmChannel): MenuEntry[] {
    const muted = mutes.muted.has(d.channelId);
    const isFriend = friends.friends.some((f) => f.id === d.recipient.id);
    const items: MenuEntry[] = [
      { label: t("ctx.markRead"), icon: <Icon name="check" size={15} />, onClick: () => clearDmUnread(d.channelId) },
      { label: t("friends.call"), icon: <Icon name="phone" size={15} />, onClick: () => { void startCall(d.recipient.id, d.recipient.username); } },
      { separator: true },
      {
        label: muted ? t("ctx.unmuteChat") : t("ctx.muteChat"),
        icon: <Icon name={muted ? "bell" : "bell-off"} size={15} />,
        onClick: () => toggleChannelMute(d.channelId),
      },
      { separator: true },
      {
        label: t("ctx.closeDm"),
        icon: <Icon name="x" size={15} />,
        onClick: () => { void api.closeDm(d.channelId).then(() => removeDmChannel(d.channelId)).catch(() => {}); },
      },
    ];
    if (isFriend) {
      items.push({
        label: t("ctx.removeFriend"), danger: true, icon: <Icon name="user" size={15} />,
        onClick: () => { void api.removeFriend(d.recipient.id).then(() => dropFriend(d.recipient.id)).catch(() => {}); },
      });
    }
    items.push({
      label: t("sidebar.block"), danger: true, icon: <Icon name="shield-off" size={15} />,
      onClick: () => {
        void (async () => {
          if (!(await confirm({
            message: t("sidebar.blockConfirm", { name: d.recipient.username }),
            highlight: d.recipient.username, danger: true, confirmLabel: t("sidebar.block"),
          }))) return;
          await api.blockUser(d.recipient.id).catch(() => {});
        })();
      },
    });
    return items;
  }
  function openChannel(id: number): void {
    setSidebarMode("channels");
    setActiveChannel(id);
    closeDrawer();
  }

  return (
    <>
      <div className="unified-sidebar-header inbox-header">
        <span className="server-name">{t("inbox.title")}</span>
      </div>

      <button className="nav-search" onClick={() => openModal("command")}>
        <Icon name="arrow-right" size={14} />
        <span>{t("cmd.search")}</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="channel-list inbox-list">
        {incoming > 0 && (
          <button className="inbox-request-card" onClick={() => { openModal("friends"); closeDrawer(); }}>
            <span className="ireq-icon"><Icon name="users" size={18} /></span>
            <span className="ireq-text">{t("inbox.requests")}</span>
            <span className="unread-badge">{incoming}</span>
          </button>
        )}

        {attention > 0 && (
          <>
            <div className="inbox-section">{t("inbox.attention")}</div>
            {unreadDms.map((d) => (
              <div key={`d${d.channelId}`} className="inbox-item unread" onClick={() => openDm(d.channelId)} onContextMenu={(e) => onDmContextMenu(e, d)}>
                <div className="dm-avatar">
                  <Avatar username={d.recipient.username} avatar={d.recipient.avatar} size={38} color="#5865f2" />
                  <span className="dm-status" style={{ background: d.recipient.status === "online" ? "var(--green, #2ecc71)" : "#747f8d" }} />
                </div>
                <div className="inbox-text">
                  <div className="inbox-row1">
                    <span className="inbox-name">{d.recipient.username}</span>
                    <span className="inbox-time">{relTime(d.lastMessageAt)}</span>
                  </div>
                  <div className="inbox-preview">{d.lastMessage ? d.lastMessage : t("inbox.newMessages", { count: d.unreadCount })}</div>
                </div>
                <span className="unread-badge">{d.unreadCount}</span>
              </div>
            ))}
            {unreadChannels.map((c) => (
              <div key={`c${c.id}`} className="inbox-item unread" onClick={() => openChannel(c.id)}>
                <div className="inbox-ch-icon"><Icon name="hash" size={18} /></div>
                <div className="inbox-text">
                  <div className="inbox-row1">
                    <span className="inbox-name">{c.name}</span>
                  </div>
                  <div className="inbox-preview">
                    {activeServerName ? `${activeServerName} · ` : ""}{t("inbox.newMessages", { count: c.unreadCount })}
                  </div>
                </div>
                <span className="unread-badge">{c.unreadCount}</span>
              </div>
            ))}
          </>
        )}

        <div className="inbox-section inbox-section-direct">
          <span>{t("inbox.direct")}</span>
          <span className="category-add-btn" title={t("friends.openFriends")} onClick={() => { openModal("friends"); closeDrawer(); }}>+</span>
        </div>

        {dms.length === 0 && attention === 0 && incoming === 0 ? (
          <div className="inbox-empty">
            <Icon name="check" size={30} />
            <div className="inbox-empty-title">{t("inbox.allCaught")}</div>
            <div className="inbox-empty-sub">{t("inbox.allCaughtSub")}</div>
            <button className="inbox-empty-btn" onClick={() => { openModal("friends"); closeDrawer(); }}>{t("friends.openFriends")}</button>
          </div>
        ) : (
          dms.map((d) => (
            <div
              key={d.channelId}
              className={"inbox-item" + (d.unreadCount > 0 ? " unread" : "")}
              onClick={() => openDm(d.channelId)}
              onContextMenu={(e) => onDmContextMenu(e, d)}
            >
              <div className="dm-avatar">
                <Avatar username={d.recipient.username} avatar={d.recipient.avatar} size={38} color="#5865f2" />
                <span className="dm-status" style={{ background: d.recipient.status === "online" ? "var(--green, #2ecc71)" : "#747f8d" }} />
              </div>
              <div className="inbox-text">
                <div className="inbox-row1">
                  <span className="inbox-name">{d.recipient.username}</span>
                  {mutes.muted.has(d.channelId) && <span className="inbox-muted"><Icon name="bell-off" size={12} /></span>}
                  <span className="inbox-time">{d.lastMessageAt ? relTime(d.lastMessageAt) : ""}</span>
                </div>
                {d.lastMessage && <div className="inbox-preview">{d.lastMessage}</div>}
              </div>
              {d.unreadCount > 0 && <span className="unread-badge">{d.unreadCount}</span>}
            </div>
          ))
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={dmMenuItems(menu.dm)} onClose={() => setMenu(null)} />}
    </>
  );
}
