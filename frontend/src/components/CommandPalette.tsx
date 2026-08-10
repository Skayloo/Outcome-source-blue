/**
 * Command palette (⌘K / Ctrl-K) — the keyboard-first heart of the reimagined shell.
 * One box to jump to any channel, DM, server, or person, and to run actions. Replaces
 * hunting through nested sidebars: type a few letters, arrow, Enter. Fully reactive to the
 * stores so results are always live.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStoreState } from "@lib/useStore";
import { serversStore } from "@stores/servers.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { friendsStore } from "@stores/friends.store";
import { membersStore } from "@stores/members.store";
import { closeModal, openModal, openSettings, setSidebarMode, toggleMemberList } from "@stores/ui.store";
import { switchServer } from "@lib/session";
import { openDm } from "@lib/dm";
import { Icon, type IconName } from "@lib/icons";
import { Avatar } from "@components/Avatar";
import { t } from "@lib/i18n";

interface Cmd {
  id: string;
  label: string;
  sub?: string;
  group: string;
  icon: IconName;
  avatar?: { name: string; url?: string | null; color?: string };
  keywords?: string;
  run: () => void;
}

export function CommandPalette() {
  useStoreState(serversStore);
  useStoreState(channelsStore);
  useStoreState(dmStore);
  useStoreState(friendsStore);
  useStoreState(membersStore);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [q]);

  const items = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [];
    const go = (fn: () => void) => () => { closeModal(); fn(); };

    // Channels of the active server
    for (const ch of channelsStore.getState().channels.values()) {
      if (ch.type === "dm") continue;
      out.push({
        id: "ch" + ch.id, group: t("cmd.channels"),
        label: ch.name, sub: ch.type === "voice" ? t("cmd.voice") : undefined,
        icon: ch.type === "voice" ? "volume-2" : "hash", keywords: ch.category ?? "",
        run: go(() => { setSidebarMode("channels"); setActiveChannel(ch.id); }),
      });
    }
    // Direct messages (existing conversations — jump straight to the channel)
    for (const d of dmStore.getState().channels) {
      out.push({
        id: "dm" + d.channelId, group: t("cmd.direct"),
        label: d.recipient.username, icon: "message-circle",
        avatar: { name: d.recipient.username, url: d.recipient.avatar },
        run: go(() => { setSidebarMode("dms"); setActiveChannel(d.channelId); }),
      });
    }
    // Servers
    for (const s of serversStore.select((x) => x.servers)) {
      out.push({
        id: "srv" + s.id, group: t("cmd.spaces"),
        label: s.name, icon: "hash",
        avatar: { name: s.name, url: s.icon, color: "var(--accent)" },
        run: go(() => { setSidebarMode("channels"); switchServer(s.id); }),
      });
    }
    // People — friends + current-server members (dedup by id)
    const seen = new Set<number>();
    const addPerson = (id: number, username: string, avatar?: string | null) => {
      if (seen.has(id)) return; seen.add(id);
      out.push({
        id: "p" + id, group: t("cmd.people"), label: username, icon: "user",
        avatar: { name: username, url: avatar }, sub: t("cmd.message"),
        run: go(() => void openDm(id)),
      });
    };
    for (const f of friendsStore.select((x) => x.friends)) addPerson(f.id, f.username, f.avatar);
    for (const m of membersStore.getState().members.values()) addPerson(m.id, m.username, m.avatar);

    // Actions
    const act = (id: string, label: string, icon: IconName, fn: () => void, kw = "") =>
      out.push({ id: "act" + id, group: t("cmd.actions"), label, icon, keywords: kw, run: go(fn) });
    act("home", t("cmd.goHome"), "message-circle", () => setSidebarMode("dms"), "dm direct");
    act("friends", t("cmd.friends"), "user-plus", () => openModal("friends"));
    act("newspace", t("cmd.newSpace"), "plus", () => openModal("create-space"), "server create join");
    act("members", t("cmd.toggleMembers"), "users", () => toggleMemberList());
    act("settings", t("cmd.settings"), "settings", () => openSettings());
    act("bug", t("cmd.reportBug"), "bug", () => openModal("bug"));
    return out;
  }, [q]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items;
    const tokens = query.split(/\s+/);
    return items.filter((it) => {
      const hay = (it.label + " " + (it.sub ?? "") + " " + (it.keywords ?? "") + " " + it.group).toLowerCase();
      return tokens.every((tk) => hay.includes(tk));
    });
  }, [items, q]);

  // Group in a stable order
  const order = [t("cmd.channels"), t("cmd.direct"), t("cmd.people"), t("cmd.spaces"), t("cmd.actions")];
  const groups = order
    .map((g) => ({ name: g, items: filtered.filter((it) => it.group === g).slice(0, 8) }))
    .filter((g) => g.items.length > 0);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); flat[active]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); closeModal(); }
  }

  return (
    <div className="cmd-overlay" onClick={closeModal}>
      <div className="cmd-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="cmd-search">
          <Icon name="arrow-right" size={16} />
          <input
            ref={inputRef} className="cmd-input" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={t("cmd.placeholder")} spellCheck={false} autoComplete="off"
          />
          <kbd className="cmd-esc">esc</kbd>
        </div>
        <div className="cmd-list" ref={listRef}>
          {flat.length === 0 && <div className="cmd-empty">{t("cmd.noResults")}</div>}
          {groups.map((g) => (
            <div className="cmd-group" key={g.name}>
              <div className="cmd-group-title">{g.name}</div>
              {g.items.map((it) => {
                const idx = flat.indexOf(it);
                return (
                  <button
                    key={it.id} data-idx={idx}
                    className={"cmd-item" + (idx === active ? " active" : "")}
                    onMouseMove={() => setActive(idx)} onClick={it.run}
                  >
                    <span className="cmd-item-icon">
                      {it.avatar
                        ? <Avatar username={it.avatar.name} avatar={it.avatar.url} size={22} color={it.avatar.color ?? "var(--bg-active)"} />
                        : <Icon name={it.icon} size={16} />}
                    </span>
                    <span className="cmd-item-label">{it.label}</span>
                    {it.sub && <span className="cmd-item-sub">{it.sub}</span>}
                    {idx === active && <Icon name="arrow-right" size={13} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
