/**
 * FriendsPanel — modal for managing friends, pending requests, and adding new
 * friends. Reuses the settings modal shell (overlay + sidebar tabs + content).
 * Data is hydrated from GET /api/v1/friends on mount and kept in the friends
 * store; mutations go through the REST api and optimistically patch the store.
 */
import { useEffect, useState, type ChangeEvent } from "react";
import { Icon } from "@lib/icons";
import { setTransientSuccess, setTransientError } from "@stores/ui.store";
import { t } from "@lib/i18n";
import { useStoreState } from "@lib/useStore";
import { Avatar } from "@components/Avatar";
import { Banner } from "@components/settings/controls";
import { api } from "@lib/services";
import { openDm } from "@lib/dm";
import { startCall } from "@lib/call";
import {
  friendsStore,
  setFriendsList,
  addOutgoingRequest,
  promoteToFriend,
  dropFriend,
} from "@stores/friends.store";
import type { PublicUser } from "@lib/types";

type FriendsTab = "all" | "pending" | "add";

const TAB_LABELS: Record<FriendsTab, () => string> = {
  all: () => t("friends.tabAll"),
  pending: () => t("friends.tabPending"),
  add: () => t("friends.tabAdd"),
};

const AVATAR_COLOR = "#5865f2";

// ---------------------------------------------------------------------------
// Row primitives
// ---------------------------------------------------------------------------

/** A single friend/request/result row: avatar + name/status + action buttons. */
function FriendRow({ user, actions }: { user: PublicUser; actions: React.ReactNode }) {
  return (
    <div className="friend-row">
      <Avatar username={user.username} avatar={user.avatar} size={40} color={AVATAR_COLOR} />
      <div className="fr-main">
        <div className="fr-name">{user.username}</div>
        <div className="fr-sub">{user.status}</div>
      </div>
      <div className="fr-actions">{actions}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// All friends tab
// ---------------------------------------------------------------------------

function AllTab({
  friends,
  onClose,
}: {
  friends: readonly PublicUser[];
  onClose: () => void;
}) {
  if (friends.length === 0) {
    return <Banner kind="info">{t("friends.noFriends")}</Banner>;
  }

  const message = (u: PublicUser) => (): void => {
    void openDm(u.id);
    onClose();
  };

  const call = (u: PublicUser) => (): void => {
    void startCall(u.id, u.username);
    onClose();
  };

  const remove = (u: PublicUser) => (): void => {
    void api.removeFriend(u.id).then(() => dropFriend(u.id));
  };

  return (
    <>
      {friends.map((u) => (
        <FriendRow
          key={u.id}
          user={u}
          actions={
            <>
              <button className="fr-icon-btn" title={t("friends.message")} onClick={message(u)}>
                <Icon name="send" size={16} />
              </button>
              <button className="fr-icon-btn call" title={t("friends.call")} onClick={call(u)}>
                <Icon name="phone" size={16} />
              </button>
              <button className="fr-icon-btn danger" title={t("friends.remove")} onClick={remove(u)}>
                <Icon name="trash-2" size={16} />
              </button>
            </>
          }
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pending requests tab
// ---------------------------------------------------------------------------

function PendingTab({
  incoming,
  outgoing,
}: {
  incoming: readonly PublicUser[];
  outgoing: readonly PublicUser[];
}) {
  if (incoming.length === 0 && outgoing.length === 0) {
    return <Banner kind="info">{t("friends.noPending")}</Banner>;
  }

  const accept = (u: PublicUser) => (): void => {
    void api.acceptFriend(u.id).then(() => promoteToFriend(u));
  };

  const drop = (u: PublicUser) => (): void => {
    void api.removeFriend(u.id).then(() => dropFriend(u.id));
  };

  return (
    <>
      {incoming.length > 0 && (
        <>
          <h3>{t("friends.incoming")}</h3>
          {incoming.map((u) => (
            <FriendRow
              key={u.id}
              user={u}
              actions={
                <>
                  <button className="fr-icon-btn accept" title={t("friends.accept")} onClick={accept(u)}>
                    <Icon name="check" size={16} />
                  </button>
                  <button className="fr-icon-btn danger" title={t("friends.decline")} onClick={drop(u)}>
                    <Icon name="x" size={16} />
                  </button>
                </>
              }
            />
          ))}
        </>
      )}
      {outgoing.length > 0 && (
        <>
          <h3>{t("friends.outgoing")}</h3>
          {outgoing.map((u) => (
            <FriendRow
              key={u.id}
              user={u}
              actions={
                <button className="fr-icon-btn danger" title={t("call.cancel")} onClick={drop(u)}>
                  <Icon name="x" size={16} />
                </button>
              }
            />
          ))}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Add friend tab
// ---------------------------------------------------------------------------

function AddTab({
  friends,
  outgoing,
}: {
  friends: readonly PublicUser[];
  outgoing: readonly PublicUser[];
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly PublicUser[]>([]);
  const [searching, setSearching] = useState(false);

  const trimmed = query.trim();
  const canSearch = trimmed.length >= 2;

  // Debounced, abortable search. Clears results when the query is too short.
  useEffect(() => {
    if (!canSearch) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = window.setTimeout(() => {
      void api
        .searchUsers(trimmed)
        .then((next) => {
          if (cancelled) return;
          setResults(next);
          setSearching(false);
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmed, canSearch]);

  const onQueryChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
  };

  const sendRequest = (u: PublicUser) => (): void => {
    void api.sendFriendRequest(u.id).then(() => {
      addOutgoingRequest(u);
      setTransientSuccess(t("friends.requestSent"));
    }).catch((e: unknown) => setTransientError(e instanceof Error ? e.message : t("sidebar.actionFailed")));
  };

  return (
    <>
      <input
        className="form-input"
        type="text"
        placeholder={t("friends.addPlaceholder")}
        value={query}
        onChange={onQueryChange}
      />
      {!canSearch ? (
        <Banner kind="info">{t("friends.searchHint")}</Banner>
      ) : !searching && results.length === 0 ? (
        <Banner kind="info">{t("friends.noResults")}</Banner>
      ) : (
        results.map((u) => {
          const alreadyFriend = friends.some((f) => f.id === u.id);
          const pending = outgoing.some((f) => f.id === u.id);
          return (
            <FriendRow
              key={u.id}
              user={u}
              actions={
                alreadyFriend ? (
                  <span className="fr-sub">{t("friends.alreadyFriend")}</span>
                ) : pending ? (
                  <span className="fr-sub">{t("friends.pendingBadge")}</span>
                ) : (
                  <button className="fr-icon-btn" title={t("friends.sendRequest")} onClick={sendRequest(u)}>
                    <Icon name="user-plus" size={16} />
                  </button>
                )
              }
            />
          );
        })
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

export function FriendsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<FriendsTab>("all");
  const f = useStoreState(friendsStore);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Refresh the friends list on mount.
  useEffect(() => {
    void api.getFriends().then(setFriendsList).catch(() => {});
  }, []);

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <div className="settings-cat">{t("friends.title")}</div>
          {(Object.keys(TAB_LABELS) as FriendsTab[]).map((key) => (
            <button
              key={key}
              className={"settings-nav-item" + (tab === key ? " active" : "")}
              onClick={() => setTab(key)}
            >{TAB_LABELS[key]()}</button>
          ))}
        </div>
        <div className="settings-content">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h1>{TAB_LABELS[tab]()}</h1>
            <button className="settings-close-btn" title={t("admin.closeEsc")} onClick={onClose}>
              <Icon name="x" size={18} />
            </button>
          </div>
          {tab === "all" && <AllTab friends={f.friends} onClose={onClose} />}
          {tab === "pending" && <PendingTab incoming={f.incoming} outgoing={f.outgoing} />}
          {tab === "add" && <AddTab friends={f.friends} outgoing={f.outgoing} />}
        </div>
      </div>
    </div>
  );
}
