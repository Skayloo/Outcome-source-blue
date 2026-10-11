/**
 * One message, open: its toolbar, who/when/to whom, its files and its body.
 *
 * The body of an HTML letter is shown in a sandboxed frame — no scripts, no same-origin, no
 * forms, no navigation of this page — under its own policy that loads NOTHING remote until the
 * administrator asks: a remote picture tells the sender the message was opened, and from whom.
 * The server has already sanitised the markup; the frame is the second, independent wall.
 * Letters are drawn on white, as they were designed — a newsletter laid out for a white page
 * turns into mud when a dark theme is forced onto it.
 */
import { useMemo, useState } from "react";
import { t } from "@lib/i18n";
import { api } from "@lib/services";
import { formatFileSize } from "@lib/format";
import { Icon, type IconName } from "@lib/icons";
import type { MailAttachment, MailMessage } from "@lib/types";
import { setTransientError } from "@stores/ui.store";
import { Avatar, Btn, IconBtn } from "@components/admin/kit";
import { fullDate, senderName } from "./mailFormat";

export interface ReaderActions {
  readonly onBack: () => void;
  readonly onReply: (all: boolean) => void;
  readonly onForward: () => void;
  readonly onEditDraft: () => void;
  readonly onStar: () => void;
  readonly onUnread: () => void;
  readonly onSpam: () => void;
  readonly onNotSpam: () => void;
  readonly onDelete: () => void;
  readonly onRestore: () => void;
}

export function MailReader({ message, actions }: { message: MailMessage; actions: ReaderActions }) {
  const [showImages, setShowImages] = useState(false);
  const folder = message.folder;
  const draft = folder === "drafts" || message.is_draft;

  return (
    <div className="mc-reader">
      <div className="mc-bar">
        <IconBtn icon="arrow-left" label={t("mail.back")} className="mc-back" onClick={actions.onBack} />
        {draft ? (
          <Btn kind="primary" size="sm" icon="pencil" onClick={actions.onEditDraft}>{t("mail.continueDraft")}</Btn>
        ) : (
          <>
            <Btn kind="secondary" size="sm" icon="reply" onClick={() => actions.onReply(false)}>{t("mail.reply")}</Btn>
            <Btn kind="ghost" size="sm" icon="reply-all" onClick={() => actions.onReply(true)}>{t("mail.replyAll")}</Btn>
            <Btn kind="ghost" size="sm" icon="forward" onClick={actions.onForward}>{t("mail.forward")}</Btn>
          </>
        )}
        <span className="adm-spacer" />
        {!draft && (
          <IconBtn icon="star" label={message.flagged ? t("mail.unstar") : t("mail.star")} active={message.flagged} onClick={actions.onStar} />
        )}
        {!draft && folder !== "sent" && (
          <IconBtn icon="mail" label={t("mail.markUnread")} onClick={actions.onUnread} />
        )}
        {folder === "junk" ? (
          <IconBtn icon="inbox" label={t("mail.notSpam")} onClick={actions.onNotSpam} />
        ) : folder === "inbox" ? (
          <IconBtn icon="octagon-alert" label={t("mail.toSpam")} onClick={actions.onSpam} />
        ) : null}
        {folder === "trash" && <IconBtn icon="undo-2" label={t("mail.restore")} onClick={actions.onRestore} />}
        <IconBtn
          icon="trash-2"
          label={folder === "trash" ? t("mail.deleteForever") : t("mail.delete")}
          onClick={actions.onDelete}
        />
      </div>

      <div className="mc-reader-head">
        <h2 className="mc-subject">{message.subject || t("mail.noSubject")}</h2>
        <div className="mc-meta">
          <Avatar name={senderName(message)} size={36} />
          <div className="mc-meta-main">
            <div className="mc-meta-from">
              <b>{senderName(message)}</b>
              {message.from_name.trim() && <span className="mc-addr">&lt;{message.from}&gt;</span>}
            </div>
            <div className="mc-meta-to">
              {t("mail.toLine", { list: message.to.join(", ") || "—" })}
              {message.cc.length > 0 && <> · {t("mail.ccLine", { list: message.cc.join(", ") })}</>}
              {message.reply_to && message.reply_to !== message.from && (
                <> · {t("mail.replyToLine", { address: message.reply_to })}</>
              )}
            </div>
          </div>
          <time className="mc-meta-date" dateTime={message.date}>{fullDate(message.date)}</time>
        </div>
        {folder === "junk" && <div className="mc-note mc-note--warn"><Icon name="octagon-alert" size={16} />{t("mail.junkNote")}</div>}
        {message.html && message.remote_images && !showImages && (
          <div className="mc-note">
            <Icon name="eye-off" size={16} />
            <span>{t("mail.imagesBlocked")}</span>
            <Btn kind="ghost" size="sm" onClick={() => setShowImages(true)}>{t("mail.showImages")}</Btn>
          </div>
        )}
        {message.attachments.length > 0 && (
          <div className="mc-files">
            {message.attachments.map((a) => <FileChip key={a.index} file={a} folder={message.folder} uid={message.uid} />)}
          </div>
        )}
      </div>

      <MailBody html={message.html} text={message.text} showImages={showImages} />
    </div>
  );
}

function MailBody({ html, text, showImages }: { html: string | null; text: string; showImages: boolean }) {
  const doc = useMemo(() => {
    if (!html) return null;
    // The frame's own policy. Inline style is how mail is written; images only as data: (the
    // server inlined the cid: ones) until asked; no scripts, fonts or media from anywhere.
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "font-src data:",
      `img-src data:${showImages ? " https:" : ""}`,
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; ");
    const base = "html,body{margin:0}body{padding:20px 24px;background:#fff;color:#1f1d24;"
      + "font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;"
      + "overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#5b3fd6}";
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
      + `<style>${base}</style>${html}`;
  }, [html, showImages]);

  if (doc === null) return <div className="mc-body"><div className="mc-text">{text || "—"}</div></div>;
  return (
    <div className="mc-body mc-body--html">
      <iframe
        className="mc-frame"
        title={t("mail.bodyFrame")}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={doc}
      />
    </div>
  );
}

function fileIcon(mime: string): IconName {
  if (mime.startsWith("image/")) return "image";
  if (mime === "message/rfc822") return "mail";
  return "file-text";
}

function FileChip({ file, folder, uid }: { file: MailAttachment; folder: MailMessage["folder"]; uid: number }) {
  const [busy, setBusy] = useState(false);
  const download = (): void => {
    setBusy(true);
    api.adminMailAttachment(folder, uid, file.index)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.file_name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      })
      .catch((e: unknown) => setTransientError(e instanceof Error ? e.message : t("mail.downloadFailed")))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" className="mc-file" onClick={download} disabled={busy} title={t("mail.download")}>
      <span className="mc-file-icon"><Icon name={fileIcon(file.mime)} size={18} /></span>
      <span className="mc-file-text">
        <span className="mc-file-name">{file.file_name}</span>
        <span className="mc-file-size">{formatFileSize(file.size)}</span>
      </span>
      <Icon name="download" size={16} />
    </button>
  );
}
