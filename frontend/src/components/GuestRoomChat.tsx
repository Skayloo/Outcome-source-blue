/**
 * The voice room's chat, for a GUEST (W3GWG-25 stage 3). Members read and write the same messages
 * through the app — they are the voice channel's own messages — but a guest has no account and
 * no socket, so this polls the guest chat endpoint and posts to it, with the LiveKit token the
 * guest joined with as the only credential. The guest sees what was said from the moment they
 * joined, not the room's history: the owner's rule.
 *
 * Mounted for the whole call so the button can count what arrives while the panel is shut;
 * the panel itself is drawn only when `open`.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import { formatTime } from "@lib/format";

interface Line { id: number; author: string; guest: boolean; content: string; timestamp: string }

const POLL_MS = 2500;
const MAX_LINES = 300;

export function GuestRoomChat(
  { code, token, open, onClose, onUnseen }:
  { code: string; token: string; open: boolean; onClose: () => void; onUnseen: (n: number) => void },
) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = useRef(new Set<number>());
  const lastId = useRef(0);
  const seenId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const merge = (incoming: Line[]): void => {
    if (incoming.length === 0) return;
    setLines((prev) => {
      const have = new Set(prev.map((l) => l.id));
      const next = [...prev, ...incoming.filter((l) => !have.has(l.id))].sort((a, b) => a.id - b.id);
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
    lastId.current = Math.max(lastId.current, ...incoming.map((l) => l.id));
  };

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const r = await fetch(`/api/v1/guest/${encodeURIComponent(code)}/chat?after=${lastId.current}`, {
          headers: { "X-Guest-Token": token },
        });
        if (r.ok && !stopped) merge(await r.json() as Line[]);
      } catch { /* offline for a moment — the next poll catches up */ }
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [code, token]);

  // What arrived while the panel was shut, other people's only.
  useEffect(() => {
    if (open) seenId.current = lastId.current;
    onUnseen(open ? 0 : lines.filter((l) => l.id > seenId.current && !mine.current.has(l.id)).length);
  }, [open, lines, onUnseen]);

  // Follow the conversation, but only if the reader was already at the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [lines, open]);

  const send = async (): Promise<void> => {
    const content = draft.trim();
    if (content.length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      const r = await fetch(`/api/v1/guest/${encodeURIComponent(code)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Guest-Token": token },
        body: JSON.stringify({ content }),
      });
      const body = await r.json().catch(() => null) as { id?: number; timestamp?: string; message?: string } | null;
      if (!r.ok || typeof body?.id !== "number") throw new Error(body?.message ?? t("guest.chatSendFailed"));
      mine.current.add(body.id);
      merge([{ id: body.id, author: t("guest.you"), guest: true, content, timestamp: body.timestamp ?? new Date().toISOString() }]);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("guest.chatSendFailed"));
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;
  return (
    <aside className="guest-chat" aria-label={t("voice.roomChat")}>
      <div className="vstage-chat-head">
        <span>{t("voice.roomChat")}</span>
        <button className="vstage-chat-close" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="guest-chat-list" ref={listRef}>
        {lines.length === 0 && <div className="guest-chat-empty">{t("guest.chatEmpty")}</div>}
        {lines.map((l) => {
          const own = mine.current.has(l.id);
          return (
            <div key={l.id} className={"guest-chat-line" + (own ? " own" : "")}>
              {!own && (
                <div className="guest-chat-author">
                  {l.author}{l.guest && <span className="dm-guest-tag">{t("chat.guestTag")}</span>}
                </div>
              )}
              <div className="guest-chat-text">{l.content}</div>
              <div className="guest-chat-time">{formatTime(l.timestamp)}</div>
            </div>
          );
        })}
      </div>
      {error && <div className="guest-chat-error" role="alert">{error}</div>}
      <form className="guest-chat-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input
          className="form-input" maxLength={1000} placeholder={t("guest.chatPlaceholder")}
          value={draft} onChange={(e) => setDraft(e.target.value)}
        />
        <button className="vsc-btn" type="submit" disabled={sending || draft.trim().length === 0} title={t("guest.chatSend")}>
          <Icon name="send" size={18} />
        </button>
      </form>
    </aside>
  );
}
