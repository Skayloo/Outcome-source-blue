import { useState, type MouseEvent } from "react";
import { useStoreState } from "@lib/useStore";
import { membersStore, type Member } from "@stores/members.store";
import { channelsStore } from "@stores/channels.store";
import { serversStore, getActiveServerId } from "@stores/servers.store";
import { authStore } from "@stores/auth.store";
import { setTransientError } from "@stores/ui.store";
import { api } from "@lib/services";
import { confirm } from "@components/ConfirmDialog";
import { openDm } from "@lib/dm";
import { startCall } from "@lib/call";
import { roleColor } from "@lib/format";
import { t } from "@lib/i18n";
import { Icon } from "@lib/icons";
import { Avatar } from "@components/Avatar";

const ROLE_ORDER = ["owner", "admin", "moderator", "member"];
const STATUS_COLOR: Record<string, string> = {
  online: "#2ecc71", idle: "#f1c40f", dnd: "#e74c3c", offline: "#747f8d",
};

export function MemberList() {
  const m = useStoreState(membersStore);
  useStoreState(channelsStore);
  useStoreState(serversStore);
  const me = authStore.getState().user;
  const canModerate = me ? ["owner", "admin"].includes(me.role) : false;
  // Per-server role management: the OWNER of the active server (or a global admin) can assign roles here.
  const activeServerId = getActiveServerId();
  const isServerOwner = serversStore.select((s) => s.servers).some((s) => s.id === activeServerId && s.owner_id === me?.id);
  const canManageServer = canModerate || isServerOwner;
  const roles = channelsStore.getState().roles;
  // Which member's action panel is expanded. Instead of a floating menu (which overflowed the
  // narrow members drawer and forced a horizontal scroll), we expand an inline panel BELOW the row,
  // pushing the members underneath it down with a height animation.
  const [openId, setOpenId] = useState<number | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setOpenId(null);
    try { await fn(); } catch (err) { setTransientError(err instanceof Error ? err.message : t("sidebar.actionFailed")); }
  }

  // Everyone on the server, online first (by role priority, then name), offline below (dimmed
  // but readable). Matches Discord: an ONLINE section on top, an OFFLINE section beneath it.
  const roleRank = (r: string): number => {
    const i = ROLE_ORDER.indexOf(r.toLowerCase());
    return i === -1 ? ROLE_ORDER.length : i;
  };
  const all = [...m.members.values()];
  const online = all
    .filter((x) => x.status !== "offline")
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.username.localeCompare(b.username));
  const offline = all
    .filter((x) => x.status === "offline")
    .sort((a, b) => a.username.localeCompare(b.username));

  const notOwner = (mem: Member) => mem.role.toLowerCase() !== "owner";

  // Inline action panel for a member (Message / Call / moderation / server role).
  const actions = (mem: Member) => (
    <div className="member-actions-list">
      <button className="member-action" onClick={() => act(() => openDm(mem.id))}>
        <Icon name="message-circle" size={15} />{t("sidebar.message")}
      </button>
      <button className="member-action" onClick={() => act(() => startCall(mem.id, mem.username))}>
        <Icon name="phone" size={15} />{t("friends.call")}
      </button>
      {/* Blocking is a USER action (available to everyone), unlike kick/ban below which are
          moderation. It cuts DMs, calls and friend requests both ways — server-enforced. */}
      <button className="member-action danger" onClick={() => act(async () => {
        if (!(await confirm({
          message: t("sidebar.blockConfirm", { name: mem.username }),
          highlight: mem.username, danger: true, confirmLabel: t("sidebar.block"),
        }))) return;
        await api.blockUser(mem.id);
      })}>
        <Icon name="shield-off" size={15} />{t("sidebar.block")}
      </button>
      {canManageServer && notOwner(mem) && (
        <button className="member-action danger" onClick={() => act(() => api.kickServerMember(activeServerId, mem.id))}>
          <Icon name="log-out" size={15} />{t("sidebar.kick")}
        </button>
      )}
      {canModerate && notOwner(mem) && (
        <button className="member-action danger" onClick={() => act(() => api.adminBanMember(mem.id, ""))}>
          <Icon name="triangle-alert" size={15} />{t("sidebar.ban")}
        </button>
      )}
      {canManageServer && notOwner(mem) && (
        <>
          <div className="member-action-label">{t("sidebar.serverRole")}</div>
          {roles.filter((r) => r.name.toLowerCase() !== "owner").map((r) => (
            <button key={r.id} className="member-action" onClick={() => act(() => api.assignServerRole(activeServerId, mem.id, r.id))}>
              {t("sidebar.makeRole", { name: r.name })}
            </button>
          ))}
          <button className="member-action" onClick={() => act(() => api.assignServerRole(activeServerId, mem.id, null))}>
            {t("sidebar.resetRole")}
          </button>
        </>
      )}
    </div>
  );

  const renderMember = (mem: Member) => {
    const hasActions = mem.id !== me?.id; // your own row has no actions to offer
    const isOpen = openId === mem.id;
    const toggle = (e: MouseEvent) => {
      e.stopPropagation();
      if (hasActions) setOpenId(isOpen ? null : mem.id);
    };
    return (
      <div className="member-row" key={mem.id}>
        <div
          className={"member-item" + (mem.status === "offline" ? " offline" : "") + (isOpen ? " active" : "")}
          onClick={toggle}
        >
          <div className="mi-avatar">
            <Avatar username={mem.username} avatar={mem.avatar} size={32} color={roleColor(mem.role)} />
            <span className="mi-status" style={{ background: STATUS_COLOR[mem.status] ?? STATUS_COLOR.offline }} />
          </div>
          <div className="mi-name" style={{ color: roleColor(mem.role) }}>{mem.username}</div>
          {hasActions && <span className={"mi-caret" + (isOpen ? " open" : "")}><Icon name="chevron-down" size={16} /></span>}
        </div>
        {hasActions && (
          <div className={"member-actions-wrap" + (isOpen ? " open" : "")}>
            <div className="member-actions-clip">{actions(mem)}</div>
          </div>
        )}
      </div>
    );
  };

  const section = (label: string, list: Member[]) =>
    list.length === 0 ? null : (
      <div>
        <div className="member-role-group">{label} — {list.length}</div>
        {list.map(renderMember)}
      </div>
    );

  return (
    <div className="member-list" onClick={() => setOpenId(null)}>
      {section(t("sidebar.online").toUpperCase(), online)}
      {section(t("sidebar.offline").toUpperCase(), offline)}
    </div>
  );
}
