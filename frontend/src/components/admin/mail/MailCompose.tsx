/**
 * Writing a letter: new, a reply, a forward, or a draft picked up again.
 *
 * Files come two ways: new ones from this computer, and files of a message already in the
 * mailbox (a forward's originals, a draft's) — those stay on the server and are only named
 * here (MailRef), so a 15 MB contract is not downloaded and uploaded again to forward it.
 * Saving a draft replaces the previous version on the server; its files then belong to the new
 * draft, so the list is re-read from it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t } from "@lib/i18n";
import { api } from "@lib/services";
import { formatFileSize } from "@lib/format";
import { Icon } from "@lib/icons";
import type { MailFolderId, MailRef } from "@lib/types";
import { confirm } from "@components/ConfirmDialog";
import { setTransientError, setTransientSuccess } from "@stores/ui.store";
import { Btn, IconBtn } from "@components/admin/kit";
import { looksLikeAddress, splitAddresses } from "./mailFormat";

/** The server's cap for one letter's files (SupportMailbox.MaxOutgoingFileBytes). */
const MAX_FILE_BYTES = 18 * 1024 * 1024;

export interface KeptFile extends MailRef {
  readonly file_name: string;
  readonly size: number;
}

export interface ComposeInit {
  readonly kind: "new" | "reply" | "forward" | "draft";
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly text: string;
  readonly reply_folder?: MailFolderId;
  readonly reply_uid?: number;
  readonly draft_uid?: number;
  readonly keep: readonly KeptFile[];
}

export function MailCompose({ init, address, onClose }:
  { init: ComposeInit; address: string; onClose: (result: "sent" | "saved" | "discarded") => void }) {
  const [to, setTo] = useState(init.to);
  const [cc, setCc] = useState(init.cc);
  const [showCc, setShowCc] = useState(init.cc.trim().length > 0);
  const [subject, setSubject] = useState(init.subject);
  const [text, setText] = useState(init.text);
  const [keep, setKeep] = useState<readonly KeptFile[]>(init.keep);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [draftUid, setDraftUid] = useState<number | undefined>(init.draft_uid);
  const [busy, setBusy] = useState<"send" | "draft" | null>(null);
  const [saved, setSaved] = useState({ to: init.to, cc: init.cc, subject: init.subject, text: init.text, keep: init.keep.length, files: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const toInput = useRef<HTMLInputElement>(null);

  // A reply starts in the text, above the quote; anything else starts with the recipient.
  useEffect(() => {
    if (init.kind === "reply") {
      const el = textArea.current;
      if (el) { el.focus(); el.setSelectionRange(0, 0); el.scrollTop = 0; }
    } else {
      toInput.current?.focus();
    }
  }, [init.kind]);

  const total = useMemo(() => keep.reduce((n, k) => n + k.size, 0) + files.reduce((n, f) => n + f.size, 0), [keep, files]);
  const dirty = to !== saved.to || cc !== saved.cc || subject !== saved.subject || text !== saved.text
    || keep.length !== saved.keep || files.length !== saved.files;

  const outgoing = () => ({
    to, cc: showCc ? cc : "", subject, text,
    reply_folder: init.reply_folder, reply_uid: init.reply_uid, draft_uid: draftUid,
    keep: keep.map(({ folder, uid, index }) => ({ folder, uid, index })), files,
  });

  const badAddress = (): string | null => {
    for (const a of [...splitAddresses(to), ...(showCc ? splitAddresses(cc) : [])])
      if (!looksLikeAddress(a)) return a;
    return null;
  };

  const send = async (): Promise<void> => {
    if (busy) return;
    if (splitAddresses(to).length + (showCc ? splitAddresses(cc).length : 0) === 0) {
      setTransientError(t("mail.needRecipient"));
      toInput.current?.focus();
      return;
    }
    const bad = badAddress();
    if (bad) { setTransientError(t("mail.badAddress", { address: bad })); return; }
    if (!subject.trim() && !(await confirm({ message: t("mail.noSubjectConfirm"), confirmLabel: t("mail.send") }))) return;
    setBusy("send");
    try {
      await api.adminMailWrite("send", outgoing());
      setTransientSuccess(t("mail.sent"));
      onClose("sent");
    } catch (e: unknown) {
      setTransientError(e instanceof Error ? e.message : t("mail.sendFailed"));
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async (): Promise<boolean> => {
    if (busy) return false;
    setBusy("draft");
    try {
      const r = await api.adminMailWrite("draft", outgoing());
      const uid = r?.uid;
      if (uid !== undefined) {
        // The files now live in the new draft — the old one, and its numbering, is gone.
        const fresh = await api.adminGetMail("drafts", uid);
        setDraftUid(uid);
        setKeep(fresh.attachments.map((a) => ({ folder: "drafts", uid, index: a.index, file_name: a.file_name, size: a.size })));
        setFiles([]);
        setSaved({ to, cc, subject, text, keep: fresh.attachments.length, files: 0 });
      }
      setTransientSuccess(t("mail.draftSaved"));
      return true;
    } catch (e: unknown) {
      setTransientError(e instanceof Error ? e.message : t("mail.draftFailed"));
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Closing keeps the work, the way Gmail does: an unsaved letter goes to Drafts on its own.
  // Asking "save?" instead would turn a dismissed dialog (Escape) into lost text.
  const close = async (): Promise<void> => {
    if (!dirty) { onClose(draftUid !== undefined ? "saved" : "discarded"); return; }
    if (await saveDraft()) onClose("saved");
  };

  const discard = async (): Promise<void> => {
    if (busy) return;
    if ((dirty || draftUid !== undefined)
      && !(await confirm({ message: t("mail.discardConfirm"), confirmLabel: t("mail.discard"), danger: true }))) return;
    if (draftUid !== undefined) {
      try { await api.adminMailDelete("drafts", [draftUid]); } catch { /* the draft simply stays */ }
    }
    onClose("discarded");
  };

  const addFiles = (list: FileList | null): void => {
    if (!list) return;
    const added = Array.from(list);
    const size = added.reduce((n, f) => n + f.size, 0);
    if (total + size > MAX_FILE_BYTES) {
      setTransientError(t("mail.filesTooBig", { mb: MAX_FILE_BYTES / 1024 / 1024 }));
      return;
    }
    setFiles((prev) => [...prev, ...added]);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
  };

  const title = { new: t("mail.newMessage"), reply: t("mail.replyTitle"), forward: t("mail.forwardTitle"), draft: t("mail.draftTitle") }[init.kind];

  return (
    <div className="mc-compose" onKeyDown={onKey}>
      <div className="mc-bar">
        <IconBtn icon="arrow-left" label={t("mail.back")} className="mc-back" onClick={() => void close()} />
        <span className="mc-compose-title">{title}</span>
        <span className="adm-spacer" />
        <IconBtn icon="x" label={t("mail.close")} onClick={() => void close()} />
      </div>

      <div className="mc-fields">
        <div className="mc-field">
          <span className="mc-field-label">{t("mail.from")}</span>
          <span className="mc-field-static">{address}</span>
        </div>
        <label className="mc-field">
          <span className="mc-field-label">{t("mail.to")}</span>
          <input ref={toInput} value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("mail.toPlaceholder")} autoComplete="off" spellCheck={false} />
          {!showCc && <button type="button" className="mc-field-link" onClick={() => setShowCc(true)}>{t("mail.cc")}</button>}
        </label>
        {showCc && (
          <label className="mc-field">
            <span className="mc-field-label">{t("mail.cc")}</span>
            <input value={cc} onChange={(e) => setCc(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        )}
        <label className="mc-field">
          <span className="mc-field-label">{t("mail.subject")}</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} />
        </label>
      </div>

      <textarea
        ref={textArea}
        className="mc-compose-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("mail.textPlaceholder")}
      />

      {(keep.length > 0 || files.length > 0) && (
        <div className="mc-files mc-files--compose">
          {keep.map((k) => (
            <span key={`k-${k.folder}-${k.uid}-${k.index}`} className="mc-file is-static">
              <span className="mc-file-icon"><Icon name="paperclip" size={16} /></span>
              <span className="mc-file-text"><span className="mc-file-name">{k.file_name}</span><span className="mc-file-size">{formatFileSize(k.size)}</span></span>
              <button type="button" className="mc-file-remove" aria-label={t("mail.removeFile")} onClick={() => setKeep((prev) => prev.filter((x) => x !== k))}><Icon name="x" size={14} /></button>
            </span>
          ))}
          {files.map((f, i) => (
            <span key={`f-${i}-${f.name}`} className="mc-file is-static">
              <span className="mc-file-icon"><Icon name="paperclip" size={16} /></span>
              <span className="mc-file-text"><span className="mc-file-name">{f.name}</span><span className="mc-file-size">{formatFileSize(f.size)}</span></span>
              <button type="button" className="mc-file-remove" aria-label={t("mail.removeFile")} onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
            </span>
          ))}
        </div>
      )}

      <div className="mc-compose-foot">
        <Btn kind="primary" icon="send" disabled={busy !== null} onClick={() => void send()}>
          {busy === "send" ? t("mail.sending") : t("mail.send")}
        </Btn>
        <IconBtn icon="paperclip" label={t("mail.attach")} onClick={() => fileInput.current?.click()} disabled={busy !== null} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <Btn kind="ghost" disabled={busy !== null || !dirty} onClick={() => void saveDraft()}>
          {busy === "draft" ? t("mail.saving") : t("mail.saveDraft")}
        </Btn>
        <span className="adm-spacer" />
        <IconBtn icon="trash-2" label={t("mail.discard")} onClick={() => void discard()} disabled={busy !== null} />
        {total > 0 && <span className="mc-size">{t("mail.filesSize", { size: formatFileSize(total), max: MAX_FILE_BYTES / 1024 / 1024 })}</span>}
        <span className="mc-hint">{t("mail.sendHint")}</span>
      </div>
    </div>
  );
}
