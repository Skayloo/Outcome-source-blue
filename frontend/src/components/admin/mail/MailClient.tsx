/**
 * The support mailbox as a mail client (2026-10-11): folders on the left, the list in the
 * middle, the letter — or the one being written — on the right. Inbox, Sent, Drafts, Spam and
 * Trash are the mail server's own folders (SPECIAL-USE), so what is done here is what a phone's
 * Mail app sees too; "Spam" / "Not spam" are moves into and out of Junk, which the mail server
 * learns from. Reference points: Gmail, Yandex Mail, Roundcube's Elastic skin.
 *
 * Everything shown is written by strangers: the list is text, and the letter's HTML lives in a
 * sandboxed frame (MailReader).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "@lib/i18n";
import { api } from "@lib/services";
import { Icon, type IconName } from "@lib/icons";
import type { MailFolder, MailFolderId, MailMessage, MailSummary } from "@lib/types";
import { confirm } from "@components/ConfirmDialog";
import { setTransientError, setTransientSuccess } from "@stores/ui.store";
import { Btn, Empty, IconBtn, SearchField, Spinner } from "@components/admin/kit";
import { MailReader } from "./MailReader";
import { MailCompose, type ComposeInit } from "./MailCompose";
import { forwardBody, forwardSubject, listDate, quoteFor, replySubject, senderName } from "./mailFormat";

const PAGE = 50;
const FOLDER_ICON: Record<MailFolderId, IconName> = {
  inbox: "inbox", sent: "send", drafts: "file", junk: "octagon-alert", trash: "trash-2",
};
const folderName = (id: MailFolderId): string => t(`mail.folder.${id}`);

/** The inbox's unread count, for the console's sidebar badge (AdminPage listens). */
export const MAIL_UNREAD_EVENT = "outcome:mail-unread";
function announceUnread(folders: readonly MailFolder[]): void {
  const inbox = folders.find((f) => f.id === "inbox");
  if (inbox) window.dispatchEvent(new CustomEvent(MAIL_UNREAD_EVENT, { detail: inbox.unread }));
}

const errText = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

export function MailClient() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [address, setAddress] = useState("");
  const [folders, setFolders] = useState<readonly MailFolder[]>([]);
  const [folder, setFolder] = useState<MailFolderId>("inbox");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [list, setList] = useState<readonly MailSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [open, setOpen] = useState<MailMessage | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [composeKey, setComposeKey] = useState(0);
  const listToken = useRef(0);

  const loadFolders = useCallback(async (): Promise<void> => {
    try {
      const r = await api.adminMailFolders();
      setConfigured(r.configured);
      setAddress(r.address);
      setFolders(r.folders);
      announceUnread(r.folders);
    } catch (e: unknown) {
      setFailed(errText(e, t("mail.loadFailed")));
    }
  }, []);

  const loadList = useCallback(async (silent = false): Promise<void> => {
    const token = ++listToken.current;
    if (!silent) setLoading(true);
    try {
      const r = await api.adminListMail(folder, PAGE, page * PAGE, search);
      if (token !== listToken.current) return; // a newer request (another folder, a search) won
      setConfigured(r.configured);
      setList(r.messages);
      setTotal(r.total);
      setFailed(null);
    } catch (e: unknown) {
      if (token === listToken.current) setFailed(errText(e, t("mail.loadFailed")));
    } finally {
      if (token === listToken.current) setLoading(false);
    }
  }, [folder, page, search]);

  useEffect(() => { void loadFolders(); }, [loadFolders]);
  useEffect(() => { void loadList(); }, [loadList]);

  // The search runs on the server; wait for the typing to settle before asking.
  useEffect(() => {
    const id = window.setTimeout(() => { setSearch(query.trim()); setPage(0); }, 350);
    return () => window.clearTimeout(id);
  }, [query]);

  // New mail without pressing anything: once a minute, quietly.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void loadFolders();
      void loadList(true);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [loadFolders, loadList]);

  const switchFolder = (id: MailFolderId): void => {
    setFolder(id);
    setPage(0);
    setQuery("");
    setSearch("");
    setSelected(new Set());
    setOpen(null);
  };

  const refresh = (): void => { void loadFolders(); void loadList(); };

  // ── opening ─────────────────────────────────────────────────────────────────────────
  const startDraft = (m: MailMessage): void => {
    setOpen(null);
    setCompose({
      kind: "draft", to: m.to.join(", "), cc: m.cc.join(", "), subject: m.subject, text: m.text,
      draft_uid: m.uid,
      keep: m.attachments.map((a) => ({ folder: "drafts", uid: m.uid, index: a.index, file_name: a.file_name, size: a.size })),
    });
    setComposeKey((k) => k + 1);
  };

  const openMessage = (m: MailSummary): void => {
    if (compose) return;
    setOpening(m.uid);
    setOpen(null);
    api.adminGetMail(folder, m.uid)
      .then((msg) => {
        if (folder === "drafts") { startDraft(msg); return; }
        setOpen(msg);
        if (!m.seen) {
          setList((prev) => prev.map((x) => (x.uid === m.uid ? { ...x, seen: true } : x)));
          setFolders((prev) => {
            const next = prev.map((f) => (f.id === folder ? { ...f, unread: Math.max(0, f.unread - 1) } : f));
            announceUnread(next);
            return next;
          });
        }
      })
      .catch((e: unknown) => setTransientError(errText(e, t("mail.openFailed"))))
      .finally(() => setOpening(null));
  };

  // ── acting on messages ──────────────────────────────────────────────────────────────
  type Act = "read" | "unread" | "star" | "unstar" | "spam" | "notspam" | "restore" | "delete";

  const act = async (kind: Act, uids: readonly number[]): Promise<void> => {
    if (uids.length === 0) return;
    if (kind === "delete" && folder === "trash" && !(await confirm({
      message: t("mail.deleteForeverConfirm", { count: uids.length }), confirmLabel: t("mail.deleteForever"), danger: true,
    }))) return;
    try {
      switch (kind) {
        case "read": case "unread":
          await api.adminMailFlags(folder, uids, { seen: kind === "read" });
          setList((prev) => prev.map((x) => (uids.includes(x.uid) ? { ...x, seen: kind === "read" } : x)));
          if (kind === "unread" && open && uids.includes(open.uid)) setOpen(null);
          break;
        case "star": case "unstar":
          await api.adminMailFlags(folder, uids, { flagged: kind === "star" });
          setList((prev) => prev.map((x) => (uids.includes(x.uid) ? { ...x, flagged: kind === "star" } : x)));
          if (open && uids.includes(open.uid)) setOpen({ ...open, flagged: kind === "star" });
          break;
        case "spam":
          await api.adminMailMove(folder, uids, "junk");
          setTransientSuccess(t("mail.movedToSpam", { count: uids.length }));
          break;
        case "notspam": case "restore":
          await api.adminMailMove(folder, uids, "inbox");
          setTransientSuccess(t(kind === "notspam" ? "mail.movedToInbox" : "mail.restored", { count: uids.length }));
          break;
        case "delete":
          await api.adminMailDelete(folder, uids);
          setTransientSuccess(t(folder === "trash" ? "mail.deletedForever" : "mail.movedToTrash", { count: uids.length }));
          break;
      }
      if (kind === "spam" || kind === "notspam" || kind === "restore" || kind === "delete") {
        setList((prev) => prev.filter((x) => !uids.includes(x.uid)));
        if (open && uids.includes(open.uid)) setOpen(null);
        void loadList(true);
      }
      setSelected(new Set());
      void loadFolders();
    } catch (e: unknown) {
      setTransientError(errText(e, t("mail.actionFailed")));
    }
  };

  const emptyFolder = async (): Promise<void> => {
    const message = folder === "junk" ? t("mail.emptySpamConfirm") : t("mail.emptyTrashConfirm");
    if (!(await confirm({ message, confirmLabel: t("mail.emptyFolder"), danger: true }))) return;
    try {
      await api.adminMailEmpty(folder);
      setOpen(null);
      setList([]);
      setTotal(0);
      void loadFolders();
    } catch (e: unknown) {
      setTransientError(errText(e, t("mail.actionFailed")));
    }
  };

  // ── writing ─────────────────────────────────────────────────────────────────────────
  const startCompose = (init: ComposeInit): void => {
    setCompose(init);
    setComposeKey((k) => k + 1);
  };

  const reply = (all: boolean): void => {
    if (!open) return;
    const fromUs = open.folder === "sent";
    const target = fromUs ? open.to.join(", ") : (open.reply_to ?? open.from);
    const others = all
      ? [...open.to, ...open.cc].filter((a) => a.toLowerCase() !== address.toLowerCase() && a.toLowerCase() !== target.toLowerCase())
      : [];
    startCompose({
      kind: "reply", to: target, cc: others.join(", "), subject: replySubject(open.subject), text: quoteFor(open),
      reply_folder: open.folder, reply_uid: open.uid, keep: [],
    });
  };

  const forward = (): void => {
    if (!open) return;
    startCompose({
      kind: "forward", to: "", cc: "", subject: forwardSubject(open.subject), text: forwardBody(open),
      keep: open.attachments.map((a) => ({ folder: open.folder, uid: open.uid, index: a.index, file_name: a.file_name, size: a.size })),
    });
  };

  const composeClosed = (result: "sent" | "saved" | "discarded"): void => {
    setCompose(null);
    void loadFolders();
    if (result !== "discarded" || folder === "drafts") void loadList(true);
  };

  // ── selection ───────────────────────────────────────────────────────────────────────
  const toggle = (uid: number): void => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    return next;
  });
  const allSelected = list.length > 0 && list.every((m) => selected.has(m.uid));
  const toggleAll = (): void => setSelected(allSelected ? new Set() : new Set(list.map((m) => m.uid)));
  const sel = [...selected];
  const anyUnread = list.some((m) => selected.has(m.uid) && !m.seen);

  if (configured === false) {
    return (
      <div className="mc mc--empty">
        <Empty icon="mail" title={t("mail.notConfiguredTitle")} text={t("adminMail.notConfigured")} />
      </div>
    );
  }

  const showingPane = compose !== null || open !== null || opening !== null;
  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min(total, (page + 1) * PAGE);
  const peopleOf = (m: MailSummary): string =>
    folder === "sent" || folder === "drafts" ? (m.to.join(", ") || t("mail.noRecipients")) : senderName(m);

  return (
    <div className={"mc" + (showingPane ? " is-reading" : "")}>
      <aside className="mc-folders">
        <Btn kind="primary" icon="square-pen" className="mc-compose-btn"
          onClick={() => { setOpen(null); startCompose({ kind: "new", to: "", cc: "", subject: "", text: "", keep: [] }); }}>
          {t("mail.compose")}
        </Btn>
        <nav className="mc-folder-list">
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className={"mc-folder" + (f.id === folder ? " is-active" : "")}
              onClick={() => switchFolder(f.id)}
              title={folderName(f.id)}
            >
              <Icon name={FOLDER_ICON[f.id]} size={17} />
              <span className="mc-folder-name">{folderName(f.id)}</span>
              {f.id === "drafts" || f.id === "sent" || f.id === "trash"
                ? (f.total > 0 && <span className="mc-folder-count is-muted">{f.total}</span>)
                : (f.unread > 0 && <span className="mc-folder-count">{f.unread}</span>)}
            </button>
          ))}
        </nav>
        {address && <div className="mc-account" title={address}><Icon name="mail" size={14} /><span>{address}</span></div>}
      </aside>

      <section className="mc-list" aria-label={folderName(folder)}>
        <div className="mc-list-head">
          <input type="checkbox" className="mc-check" checked={allSelected} onChange={toggleAll}
            aria-label={t("mail.selectAll")} disabled={list.length === 0} />
          {selected.size === 0 ? (
            <>
              <SearchField value={query} onChange={setQuery} placeholder={t("mail.searchIn", { folder: folderName(folder) })} />
              <IconBtn icon="refresh-cw" label={t("mail.refresh")} onClick={refresh} disabled={loading} />
            </>
          ) : (
            <div className="mc-bulk">
              <span className="mc-bulk-count">{t("mail.selected", { count: selected.size })}</span>
              <IconBtn icon={anyUnread ? "mail-open" : "mail"} label={anyUnread ? t("mail.markRead") : t("mail.markUnread")}
                onClick={() => void act(anyUnread ? "read" : "unread", sel)} />
              {folder === "inbox" && <IconBtn icon="octagon-alert" label={t("mail.toSpam")} onClick={() => void act("spam", sel)} />}
              {folder === "junk" && <IconBtn icon="inbox" label={t("mail.notSpam")} onClick={() => void act("notspam", sel)} />}
              {folder === "trash" && <IconBtn icon="undo-2" label={t("mail.restore")} onClick={() => void act("restore", sel)} />}
              <IconBtn icon="trash-2" label={folder === "trash" ? t("mail.deleteForever") : t("mail.delete")}
                onClick={() => void act("delete", sel)} />
              <span className="adm-spacer" />
              <IconBtn icon="x" label={t("mail.clearSelection")} onClick={() => setSelected(new Set())} />
            </div>
          )}
        </div>

        {(folder === "junk" || folder === "trash") && total > 0 && !search && (
          <div className="mc-list-banner">
            <span>{folder === "junk" ? t("mail.spamBanner") : t("mail.trashBanner")}</span>
            <Btn kind="ghost" size="sm" onClick={() => void emptyFolder()}>
              {folder === "junk" ? t("mail.emptySpam") : t("mail.emptyTrash")}
            </Btn>
          </div>
        )}

        <div className="mc-items">
          {failed && list.length === 0 ? (
            <Empty icon="triangle-alert" title={t("mail.loadFailed")} text={failed}>
              <Btn kind="secondary" size="sm" icon="refresh-cw" onClick={refresh}>{t("mail.retry")}</Btn>
            </Empty>
          ) : loading && list.length === 0 ? (
            <div className="mc-loading"><Spinner size={20} /></div>
          ) : list.length === 0 ? (
            <Empty icon={search ? "search" : FOLDER_ICON[folder]} title={search ? t("mail.nothingFound") : t("mail.folderEmpty")}
              text={search ? t("mail.nothingFoundText") : t(`mail.emptyText.${folder}`)} />
          ) : (
            list.map((m) => (
              <MailRow
                key={m.uid}
                m={m}
                people={peopleOf(m)}
                selected={selected.has(m.uid)}
                current={open?.uid === m.uid || opening === m.uid}
                onOpen={() => openMessage(m)}
                onToggle={() => toggle(m.uid)}
                onStar={() => void act(m.flagged ? "unstar" : "star", [m.uid])}
              />
            ))
          )}
        </div>

        {total > PAGE && (
          <div className="mc-list-foot">
            <span>{t("mail.range", { from, to, total })}</span>
            <IconBtn icon="chevron-left" label={t("mail.newer")} disabled={page === 0} onClick={() => setPage((p) => p - 1)} />
            <IconBtn icon="chevron-right" label={t("mail.older")} disabled={to >= total} onClick={() => setPage((p) => p + 1)} />
          </div>
        )}
      </section>

      <section className="mc-pane">
        {compose ? (
          <MailCompose key={composeKey} init={compose} address={address} onClose={composeClosed} />
        ) : open ? (
          <MailReader
            message={open}
            actions={{
              onBack: () => setOpen(null),
              onReply: reply,
              onForward: forward,
              onEditDraft: () => startDraft(open),
              onStar: () => void act(open.flagged ? "unstar" : "star", [open.uid]),
              onUnread: () => void act("unread", [open.uid]),
              onSpam: () => void act("spam", [open.uid]),
              onNotSpam: () => void act("notspam", [open.uid]),
              onDelete: () => void act("delete", [open.uid]),
              onRestore: () => void act("restore", [open.uid]),
            }}
          />
        ) : opening !== null ? (
          <div className="mc-loading"><Spinner size={22} /></div>
        ) : (
          <Empty icon="mail-open" title={t("mail.nothingOpen")} text={t("mail.nothingOpenText")} />
        )}
      </section>
    </div>
  );
}

function MailRow({ m, people, selected, current, onOpen, onToggle, onStar }: {
  m: MailSummary; people: string; selected: boolean; current: boolean;
  onOpen: () => void; onToggle: () => void; onStar: () => void;
}) {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className={"mc-row" + (m.seen ? "" : " is-unread") + (current ? " is-current" : "") + (selected ? " is-selected" : "")}
      onClick={onOpen}
      onKeyDown={onKey}
    >
      <div className="mc-row-side" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" className="mc-check" checked={selected} onChange={onToggle} aria-label={t("mail.select")} />
        <button type="button" className={"mc-star" + (m.flagged ? " is-on" : "")} onClick={onStar}
          aria-label={m.flagged ? t("mail.unstar") : t("mail.star")}>
          <Icon name="star" size={15} />
        </button>
      </div>
      <div className="mc-row-main">
        <div className="mc-row-top">
          {!m.seen && <i className="mc-unread-dot" aria-label={t("mail.unread")} />}
          <span className="mc-row-from">{people}</span>
          {m.answered && <Icon name="reply" size={13} className="mc-row-mark" />}
          {m.has_attachments && <Icon name="paperclip" size={13} className="mc-row-mark" />}
          <span className="mc-row-date">{listDate(m.date)}</span>
        </div>
        <div className="mc-row-subject">{m.subject || t("mail.noSubject")}</div>
        {m.preview && <div className="mc-row-preview">{m.preview}</div>}
      </div>
    </div>
  );
}
