/**
 * A text file read in place, as Discord shows one: the first lines in a monospace box, a chevron
 * that opens the rest, full screen, copy, download. What a line longer than 4000 characters is sent
 * as (message.txt — lib/textFiles), and any other small .txt/.log/.md/.csv.
 *
 * The text is a React text node, never markup, so a file that claims to be anything renders as
 * letters. Until it has loaded — or when it cannot be read — this is the ordinary file card.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@lib/icons";
import { assetUrl } from "@lib/serverHost";
import { formatFileSize } from "@lib/format";
import { readTextFile } from "@lib/textFiles";
import { setTransientSuccess } from "@stores/ui.store";
import { t } from "@lib/i18n";
import type { Attachment } from "@lib/types";

/** Drawn inline at most: a 1 MB log as one text node in every message would slow the whole list. */
const INLINE_CHARS = 60_000;

export function TextFileCard({ att }: { att: Attachment }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const url = assetUrl(att.url);

  useEffect(() => {
    let live = true;
    setText(null);
    setFailed(false);
    void readTextFile(att.id, url).then((s) => {
      if (!live) return;
      if (s === null) setFailed(true);
      else setText(s);
    });
    return () => { live = false; };
  }, [att.id, url]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setFull(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);

  const download = (
    <a className="msg-file-download" href={url} download={att.filename} title={t("chat.download")}>
      <Icon name="download" size={16} />
    </a>
  );

  if (text === null) {
    return (
      <div className="msg-file">
        <div className="msg-file-inner">
          <div className="msg-file-icon"><Icon name="file-text" size={18} /></div>
          <div>
            <div className="msg-file-name">{att.filename}</div>
            <div className="msg-file-size">{failed ? formatFileSize(att.size) : t("chat.textFileLoading")}</div>
          </div>
          {download}
        </div>
      </div>
    );
  }

  const cut = text.length > INLINE_CHARS;
  const shown = cut ? text.slice(0, INLINE_CHARS) : text;
  const lines = text.split("\n").length;
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => setTransientSuccess(t("chat.textFileCopied")));
  };

  return (
    <div className={`msg-textfile${open ? " open" : ""}`}>
      <pre className="msg-textfile-body" onClick={open ? undefined : () => setOpen(true)}>
        {shown}
        {open && cut && <span className="msg-textfile-cut">{"\n"}{t("chat.textFileCut", { n: INLINE_CHARS.toLocaleString() })}</span>}
      </pre>
      <div className="msg-textfile-bar">
        <button className="msg-textfile-toggle" onClick={() => setOpen(!open)} aria-expanded={open}
          title={open ? t("chat.textFileCollapse") : t("chat.textFileExpand")}>
          <Icon name={open ? "chevron-up" : "chevron-down"} size={18} />
        </button>
        <div className="msg-textfile-info">
          <div className="msg-textfile-name">{att.filename}</div>
          <div className="msg-file-size">{formatFileSize(att.size)} · {t("chat.textFileLines", { n: lines })}</div>
        </div>
        <button className="msg-file-download" onClick={copy} title={t("chat.copyText")}><Icon name="copy" size={16} /></button>
        <button className="msg-file-download" onClick={() => setFull(true)} title={t("chat.textFileFull")}><Icon name="maximize" size={16} /></button>
        {download}
      </div>
      {full && createPortal(
        <div className="modal-overlay visible textfile-overlay" onMouseDown={() => setFull(false)}>
          <div className="textfile-full" role="dialog" aria-modal="true" aria-label={att.filename} onMouseDown={(e) => e.stopPropagation()}>
            <div className="textfile-full-head">
              <Icon name="file-text" size={18} />
              <div className="msg-textfile-info">
                <div className="msg-textfile-name">{att.filename}</div>
                <div className="msg-file-size">{formatFileSize(att.size)} · {t("chat.textFileLines", { n: lines })}</div>
              </div>
              <button className="msg-file-download" onClick={copy} title={t("chat.copyText")}><Icon name="copy" size={16} /></button>
              {download}
              <button className="msg-file-download" onClick={() => setFull(false)} title={t("common.close")}><Icon name="x" size={16} /></button>
            </div>
            <pre className="textfile-full-body">{text}</pre>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
