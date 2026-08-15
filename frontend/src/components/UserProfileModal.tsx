import { useStoreState } from "@lib/useStore";
import { membersStore } from "@stores/members.store";
import { friendsStore, addOutgoingRequest, promoteToFriend } from "@stores/friends.store";
import { api } from "@lib/services";
import { authStore } from "@stores/auth.store";
import { openDm } from "@lib/dm";
import { startCall } from "@lib/call";
import { setTransientError } from "@stores/ui.store";
import { ModalPortal } from "@components/ModalPortal";
import { Avatar } from "@components/Avatar";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";

const ROLE_LABELS: Record<string, string> = {
  owner: "Владелец",
  admin: "Админ",
  moderator: "Модератор",
};

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** "август 2026" — a join date is about the era, not the day. */
function monthYear(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Who someone is, opened from wherever they appear: the DM header, a message author,
 * a row in the roster.
 *
 * The roster carries the full record — role, presence, join date — so prefer it. A DM peer
 * who is not on this server is not in it, so fall back to the name and picture the caller
 * already had rather than showing nothing.
 */
export function UserProfileModal(
  { userId, username, avatar, onClose }:
  { userId: number; username: string; avatar: string | null; onClose: () => void },
): React.ReactElement {
  const m = useStoreState(membersStore).members.get(userId);
  const me = useStoreState(authStore).user;
  const fr = useStoreState(friendsStore);
  const self = me?.id === userId;

  const name = m?.username ?? username;
  const pic = m?.avatar ?? avatar;
  const online = m != null && m.status !== "offline";
  const role = m?.role?.toLowerCase() ?? "member";
  const since = m?.createdAt != null ? monthYear(m.createdAt) : null;

  const isFriend = fr.friends.some((u) => u.id === userId);
  const requested = fr.outgoing.some((u) => u.id === userId);
  const theyAsked = fr.incoming.some((u) => u.id === userId);
  const asUser = { id: userId, username: name, avatar: pic, status: online ? "online" : "offline" };

  const friendButton = isFriend ? (
    <div className="profile-action muted" aria-disabled>
      <Icon name="check" size={17} /> У вас в друзьях
    </div>
  ) : theyAsked ? (
    <button
      className="profile-action"
      onClick={() => run(async () => { await api.acceptFriend(userId); promoteToFriend(asUser); })}
    >
      <Icon name="check" size={17} /> Принять заявку в друзья
    </button>
  ) : requested ? (
    <div className="profile-action muted" aria-disabled>
      <Icon name="check" size={17} /> Заявка отправлена
    </div>
  ) : (
    <button
      className="profile-action"
      onClick={() => run(async () => { await api.sendFriendRequest(userId); addOutgoingRequest(asUser); })}
    >
      <Icon name="user-plus" size={17} /> Добавить в друзья
    </button>
  );

  async function run(fn: () => Promise<unknown> | unknown): Promise<void> {
    onClose();
    try { await fn(); } catch (err) {
      setTransientError(err instanceof Error ? err.message : t("sidebar.actionFailed"));
    }
  }

  return (
    <ModalPortal>
      <div className="settings-overlay open" onClick={onClose}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <button className="profile-close" onClick={onClose} title={t("common.close")}>
            <Icon name="x" size={18} />
          </button>

          <div className="profile-head">
            <div className="profile-avatar-wrap">
              <Avatar username={name} avatar={pic} size={88} color="#8b5cf6" />
              <span className={"profile-presence" + (online ? " online" : "")} />
            </div>
            <div className="profile-name">{name}</div>
            <div className={"profile-status" + (online ? " online" : "")}>
              {online ? "в сети" : "не в сети"}
            </div>
          </div>

          <div className="profile-facts">
            <div className="profile-fact">
              <Icon name={role === "member" ? "user" : "shield"} size={17} />
              <span className="pf-label">Роль</span>
              <span className={"pf-value" + (role === "member" ? "" : " accent")}>
                {ROLE_LABELS[role] ?? "Участник"}
              </span>
            </div>
            {since != null && (
              <div className="profile-fact">
                <Icon name="flag" size={17} />
                <span className="pf-label">В Outcome с</span>
                <span className="pf-value">{since}</span>
              </div>
            )}
            <div className="profile-fact">
              <Icon name="hash" size={17} />
              <span className="pf-label">Имя пользователя</span>
              <span className="pf-value">{name}</span>
            </div>
          </div>

          {!self && (
            <div className="profile-actions">
              <button className="profile-action" onClick={() => run(() => openDm(userId))}>
                <Icon name="message-circle" size={17} /> Написать сообщение
              </button>
              <button className="profile-action call" onClick={() => run(() => startCall(userId, name))}>
                <Icon name="phone" size={17} /> Позвонить
              </button>
              {/* Friendship, in the same four states the mobile sheet shows. It was missing
                  here entirely, which made the card able to open a private chat with somebody
                  but not to befriend them — and left the friends list reachable only from a
                  screen most people never open. Nothing about it depends on a role. */}
              {friendButton}
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
