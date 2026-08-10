import { useState, type KeyboardEvent } from "react";
import { useStoreState } from "@lib/useStore";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { uiStore, toggleMemberList, openModal } from "@stores/ui.store";
import { openDrawer } from "@stores/mobile.store";
import { getActiveTarget } from "@lib/activeTarget";
import { voiceStore } from "@stores/voice.store";
import { SearchOverlay } from "@components/SearchOverlay";
import { UserProfileModal } from "@components/UserProfileModal";
import { PinnedPanel } from "@components/PinnedPanel";
import { startCall } from "@lib/call";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";

export function ChatHeader({ channelId, onClose }: { channelId?: number; onClose?: () => void } = {}) {
  useStoreState(channelsStore);
  useStoreState(dmStore);
  const target = getActiveTarget(channelId);
  const isDm = target?.type === "dm";
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  // Who to show a profile for, or null. The header is where a DM peer's name lives, so it
  // is the natural door into them.
  const [profile, setProfile] = useState<{ id: number; username: string; avatar: string | null } | null>(null);

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && query.trim()) setSearchOpen(true);
  }

  return (
    <>
      <div className={"chat-header" + (onClose ? " chat-header-secondary" : "")}>
        {/* The split pane's own menu button would open the sidebar it already sits next to. */}
        {!onClose && (
          <button className="input-btn mobile-only" title={t("chat.menu")} onClick={() => openDrawer("sidebar")}>☰</button>
        )}
        <span className="ch-hash">{isDm ? "@" : "#"}</span>
        <span
          className={"ch-name" + (isDm && target?.peerId != null ? " clickable" : "")}
          onClick={isDm && target?.peerId != null
            ? () => setProfile({ id: target.peerId!, username: target.name, avatar: null })
            : undefined}
        >{target?.name ?? "—"}</span>
        <div className="ch-divider" />
        <span className="ch-topic" />
        <div className="ch-tools">
          <input
            className="search-input"
            placeholder={t("chat.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {isDm && target?.peerId != null && (
            <button
              className="dm-call-btn"
              title={t("friends.call")}
              onClick={() => {
                // Already in this DM's call → the stage is the active view; ringing the
                // peer again from inside the call makes no sense.
                if (voiceStore.getState().currentChannelId === target.id) return;
                void startCall(target.peerId!, target.name);
              }}
            >
              <Icon name="phone" size={18} />
            </button>
          )}
          {target && !isDm && (
            <div style={{ position: "relative", display: "inline-flex" }}>
              <button title={t("chat.pinnedMessages")} onClick={() => setPinsOpen((o) => !o)}><Icon name="pin" size={18} /></button>
              {pinsOpen && <PinnedPanel channelId={target.id} onClose={() => setPinsOpen(false)} />}
            </div>
          )}
          {!isDm && (
            <button title={t("chat.members")} onClick={() => {
              // Home/DM view has no server roster — the people icon means FRIENDS there.
              // (It used to flip the suppressed member-list state, which did nothing visible
              // but then popped the roster open on the next server you visited.)
              if (uiStore.getState().sidebarMode === "dms") { openModal("friends"); return; }
              if (window.innerWidth <= 768) openDrawer("members"); else toggleMemberList();
            }}><Icon name="users" size={18} /></button>
          )}
          {onClose && (
            <button title="Закрыть панель" onClick={onClose}><Icon name="x" size={18} /></button>
          )}
        </div>
      </div>
      {searchOpen && <SearchOverlay initialQuery={query} onClose={() => setSearchOpen(false)} />}
      {profile && (
        <UserProfileModal
          userId={profile.id}
          username={profile.username}
          avatar={profile.avatar}
          onClose={() => setProfile(null)}
        />
      )}
    </>
  );
}
