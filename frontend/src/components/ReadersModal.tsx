/**
 * Who read one's own message in a channel — in place of the ✓/✓✓ channels used to show (the owner,
 * 2026-10-28: "статусы из каналов убрать и показывать кто прочитал при правом клике как и реакции").
 * The server answers the message's author only (GET /messages/{id}/readers); "read" means the
 * person opened the channel after the message was written. A DM keeps its ticks.
 */
import { useEffect, useState } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Avatar } from "@components/Avatar";
import { ModalPortal } from "@components/ModalPortal";

export interface Readers {
  readonly count: number;
  readonly users: readonly { id: number; username: string; avatar: string | null }[];
}

/** Asked again every time: a read marker moves whenever someone opens the channel. */
export function loadReaders(messageId: number): Promise<Readers> {
  return api.getMessageReaders(messageId);
}

export function readersLabel(r: Readers | null | "failed"): string {
  if (r === null) return t("chat.readersLoading");
  if (r === "failed") return t("chat.readers");
  return r.count === 0 ? t("chat.readersNone") : t("chat.readersCount", { count: r.count });
}

export function ReadersModal({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const [readers, setReaders] = useState<Readers | null | "failed">(null);
  useEffect(() => {
    let live = true;
    loadReaders(messageId).then((r) => { if (live) setReaders(r); }, () => { if (live) setReaders("failed"); });
    return () => { live = false; };
  }, [messageId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  const list = readers !== null && readers !== "failed" ? readers.users : [];
  return (
    <ModalPortal>
      <div className="modal-overlay visible" onClick={onClose}>
        <div className="modal reaction-modal readers-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("chat.readers")}>
          <div className="modal-header">
            <h3>{readersLabel(readers)}</h3>
            <button className="modal-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
          </div>
          <div className="modal-body rx-list">
            {readers === null && <div className="reaction-card-loading">…</div>}
            {readers === "failed" && <div className="reaction-card-loading">{t("chat.readersFailed")}</div>}
            {list.map((u) => (
              <div className="rx-row" key={u.id}>
                <Avatar username={u.username} avatar={u.avatar} size={32} />
                <span className="rx-name">{u.username}</span>
              </div>
            ))}
            {readers !== null && readers !== "failed" && readers.count > list.length && (
              <div className="reaction-card-loading">{t("chat.reactedAndMore", { n: readers.count - list.length })}</div>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
