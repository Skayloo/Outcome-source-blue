/**
 * A reaction under a message, and who put it — as in Telegram (the owner, 2026-10-21: "не видно
 * кто поставил реакцию"). Hovering the chip shows a card with the first people; clicking the card
 * opens the full list, one tab per emoji. A click on the chip itself still toggles your own
 * reaction; on a touch screen, where there is no hover, a long press (contextmenu) opens the list.
 *
 * Who reacted is asked from the server when first needed (GET /messages/{id}/reactions — it
 * checks the reader may see the message) and kept per message until its reactions change.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Avatar } from "@components/Avatar";
import { ModalPortal } from "@components/ModalPortal";
import type { ReactionSummary } from "@lib/types";

export interface Reactor { readonly id: number; readonly username: string; readonly avatar: string | null }
export interface ReactionGroup { readonly emoji: string; readonly count: number; readonly users: readonly Reactor[] }

const HOVER_DELAY_MS = 350;
const CLOSE_DELAY_MS = 180;
const CARD_PEOPLE = 6;

// Per message: what its reactions looked like when asked, and the answer. A different shape
// (someone added or took one back) means the answer is stale and is asked again.
const cache = new Map<number, { shape: string; groups: Promise<readonly ReactionGroup[]> }>();

function shapeOf(reactions: readonly ReactionSummary[]): string {
  return reactions.map((r) => `${r.emoji}:${r.count}`).join("|");
}

function loadReactors(messageId: number, reactions: readonly ReactionSummary[]): Promise<readonly ReactionGroup[]> {
  const shape = shapeOf(reactions);
  const hit = cache.get(messageId);
  if (hit && hit.shape === shape) return hit.groups;
  const groups = api.getMessageReactions(messageId).then((r) => r.reactions);
  groups.catch(() => cache.delete(messageId));
  cache.set(messageId, { shape, groups });
  return groups;
}

export function ReactionChip({ messageId, reaction, all, onToggle }: {
  messageId: number;
  reaction: ReactionSummary;
  /** Every reaction of the message — the full list shows them all. */
  all: readonly ReactionSummary[];
  onToggle: () => void;
}) {
  const chip = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ left: number; bottom: number } | null>(null);
  const [groups, setGroups] = useState<readonly ReactionGroup[] | null>(null);
  const [full, setFull] = useState(false);
  const openTimer = useRef(0);
  const closeTimer = useRef(0);

  const fetchNow = useCallback(() => {
    void loadReactors(messageId, all).then(setGroups).catch(() => setGroups([]));
  }, [messageId, all]);

  const show = (): void => {
    window.clearTimeout(closeTimer.current);
    if (card) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      const r = chip.current?.getBoundingClientRect();
      if (!r) return;
      fetchNow();
      setCard({ left: Math.max(8, Math.min(r.left, window.innerWidth - 268)), bottom: window.innerHeight - r.top + 6 });
    }, HOVER_DELAY_MS);
  };
  const hide = (): void => {
    window.clearTimeout(openTimer.current);
    closeTimer.current = window.setTimeout(() => setCard(null), CLOSE_DELAY_MS);
  };
  useEffect(() => () => { window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current); }, []);

  const openFull = (): void => {
    window.clearTimeout(openTimer.current);
    setCard(null);
    fetchNow();
    setFull(true);
  };

  const mine = groups?.find((g) => g.emoji === reaction.emoji);
  const shown = mine?.users.slice(0, CARD_PEOPLE) ?? [];
  const more = (mine?.count ?? reaction.count) - shown.length;

  return (
    <>
      <div
        ref={chip}
        className={"reaction-chip" + (reaction.me ? " me" : "")}
        onClick={onToggle}
        onMouseEnter={show}
        onMouseLeave={hide}
        onContextMenu={(e) => { e.preventDefault(); openFull(); }}
      >
        <span>{reaction.emoji}</span><span className="rc-count">{reaction.count}</span>
      </div>

      {card && createPortal(
        <div className="reaction-card" style={{ left: card.left, bottom: card.bottom }}
             onMouseEnter={show} onMouseLeave={hide} onClick={openFull} role="button" tabIndex={-1}>
          <div className="reaction-card-head"><span>{reaction.emoji}</span><span>{reaction.count}</span></div>
          {!groups ? (
            <div className="reaction-card-loading">…</div>
          ) : (
            <>
              {shown.map((u) => (
                <div className="reaction-card-row" key={u.id}>
                  <Avatar username={u.username} avatar={u.avatar} size={22} />
                  <span className="reaction-card-name">{u.username}</span>
                </div>
              ))}
              {more > 0 && <div className="reaction-card-more">{t("chat.reactedAndMore", { n: more })}</div>}
            </>
          )}
          <div className="reaction-card-hint">{t("chat.reactionsShowAll")}</div>
        </div>,
        document.body,
      )}

      {full && <ReactionListModal groups={groups} initial={reaction.emoji} onClose={() => setFull(false)} />}
    </>
  );
}

/** Everyone who reacted: "All" first, then one tab per emoji. */
function ReactionListModal({ groups, initial, onClose }: {
  groups: readonly ReactionGroup[] | null;
  initial: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<string>(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  const total = groups?.reduce((n, g) => n + g.count, 0) ?? 0;
  const rows: readonly { user: Reactor; emoji: string }[] = !groups ? []
    : tab === "*" ? groups.flatMap((g) => g.users.map((user) => ({ user, emoji: g.emoji })))
    : (groups.find((g) => g.emoji === tab)?.users ?? []).map((user) => ({ user, emoji: tab }));

  return (
    <ModalPortal>
      <div className="modal-overlay visible" onClick={onClose}>
        <div className="modal reaction-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("chat.reactionsTitle")}>
          <div className="modal-header">
            <h3>{t("chat.reactionsTitle")}</h3>
            <button className="modal-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
          </div>
          <div className="rx-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "*"} className={"rx-tab" + (tab === "*" ? " is-active" : "")} onClick={() => setTab("*")}>
              {t("chat.reactionsAll")} <span>{total}</span>
            </button>
            {groups?.map((g) => (
              <button key={g.emoji} role="tab" aria-selected={tab === g.emoji} className={"rx-tab" + (tab === g.emoji ? " is-active" : "")}
                      onClick={() => setTab(g.emoji)}>
                {g.emoji} <span>{g.count}</span>
              </button>
            ))}
          </div>
          <div className="modal-body rx-list">
            {!groups ? <div className="reaction-card-loading">…</div> : rows.map(({ user, emoji }) => (
              <div className="rx-row" key={`${emoji}:${user.id}`}>
                <Avatar username={user.username} avatar={user.avatar} size={32} />
                <span className="rx-name">{user.username}</span>
                {tab === "*" && <span className="rx-emoji">{emoji}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
