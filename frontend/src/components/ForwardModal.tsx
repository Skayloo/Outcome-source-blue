import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dmStore } from "@stores/dm.store";
import { channelsStore } from "@stores/channels.store";
import { serversStore, getActiveServerId } from "@stores/servers.store";
import { setTransientSuccess } from "@stores/ui.store";
import { api, wsSend } from "@lib/services";
import { Avatar } from "@components/Avatar";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import type { Message } from "@stores/messages.store";

interface Target {
  readonly id: number;
  readonly dm: boolean;
  readonly name: string;
  readonly sub: string | null;
  readonly avatar: string | null;
}

/** Telegram-style forward dialog: search on top, the chat list (DMs, then this server's
 *  channels tagged with the server name), an optional comment that is sent as YOUR message
 *  right before the forwarded one. */
export function ForwardModal({ message, onClose }: { message: Message; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [comment, setComment] = useState("");
  const [idx, setIdx] = useState(0);
  // Text channels of the user's OTHER servers, fetched on open (active server's come
  // from the live store). Forwarding may target any server they're a member of.
  const [remote, setRemote] = useState<Target[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // preventScroll: focusing a node that lives inside the message list's scroll parent made
  // Chrome yank the chat to the top; the portal below also moves us out of that container.
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);

  const activeServerId = getActiveServerId();
  const servers = serversStore.getState().servers;
  const serverName = servers.find((s) => s.id === activeServerId)?.name ?? "";

  useEffect(() => {
    const others = servers.filter((s) => s.id !== activeServerId);
    let cancelled = false;
    void Promise.all(
      others.map((s) =>
        api.getServerChannels(s.id)
          .then((chs) => chs
            .filter((c) => c.type === "text" || c.type === "announcement")
            .map((c) => ({ id: c.id, dm: false, name: c.name, sub: s.name, avatar: null })))
          .catch(() => [] as Target[]),
      ),
    ).then((lists) => { if (!cancelled) setRemote(lists.flat()); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targets: Target[] = [
    ...dmStore.getState().channels.map((d) => ({
      id: d.channelId, dm: true, name: d.recipient.username, sub: null, avatar: d.recipient.avatar,
    })),
    ...[...channelsStore.getState().channels.values()]
      .filter((c) => c.type === "text" || c.type === "announcement")
      .map((c) => ({ id: c.id, dm: false, name: c.name, sub: serverName || null, avatar: null })),
    ...remote,
  ].filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase()));
  const sel = Math.min(idx, Math.max(0, targets.length - 1));

  function send(x: Target): void {
    // Telegram order: your comment first, the forwarded message right after.
    const note = comment.trim();
    if (note.length > 0) {
      wsSend("chat_send", { channel_id: x.id, content: note });
    }
    const content = message.content;
    wsSend("chat_send", {
      channel_id: x.id,
      content,
      forwarded_from: message.forwardedFrom ?? message.user.username,
      attachments: message.attachments.map((a) => a.id),
    });
    setTransientSuccess(t("chat.forwardedTo", { name: x.dm ? x.name : `#${x.name}` }));
    onClose();
  }

  function onNavKey(e: React.KeyboardEvent): boolean {
    if (e.key === "Escape") { onClose(); return true; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, targets.length - 1)); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); return true; }
    if (e.key === "Enter" && targets[sel]) { e.preventDefault(); send(targets[sel]); return true; }
    return false;
  }

  return createPortal(
    <div className="modal-overlay visible" onMouseDown={onClose}>
      <div className="modal forward-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="forward-head">
          <button className="forward-close" onClick={onClose} aria-label={t("common.close")}><Icon name="x" size={16} /></button>
          <input
            ref={inputRef}
            className="form-input forward-search"
            placeholder={t("chat.forwardSearch")}
            value={q}
            onChange={(e) => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={onNavKey}
          />
        </div>
        <div className="forward-list">
          {targets.length === 0 && <div className="forward-empty">{t("chat.forwardNoMatches")}</div>}
          {targets.map((x, i) => (
            <div
              key={`${x.dm ? "d" : "c"}${x.id}`}
              className={"forward-item" + (i === sel ? " active" : "")}
              onClick={() => send(x)}
              onMouseEnter={() => setIdx(i)}
            >
              {x.dm
                ? <Avatar username={x.name} avatar={x.avatar} size={32} color="#8b5cf6" />
                : <span className="forward-hash"><Icon name="hash" size={16} /></span>}
              <span className="forward-name">{x.name}</span>
              {x.sub && <span className="forward-sub">{x.sub}</span>}
            </div>
          ))}
        </div>
        <div className="forward-comment">
          <input
            className="form-input"
            placeholder={t("chat.forwardComment")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={onNavKey}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
