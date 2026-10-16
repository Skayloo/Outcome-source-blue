import { useEffect, useState } from "react";
import { assetUrl } from "@lib/serverHost";
import { heifToJpeg, jpegName } from "@lib/heic";
import { openLightbox } from "@stores/lightbox.store";
import { formatFileSize } from "@lib/format";
import { t } from "@lib/i18n";
import type { Attachment } from "@lib/types";

/** Decoded HEICs by attachment id, for the page's lifetime: scrolling a chat back and forth must
 *  not download and decode the same photo again. */
const decoded = new Map<string, Promise<string | null>>();

function decode(att: Attachment): Promise<string | null> {
  let p = decoded.get(att.id);
  if (!p) {
    p = fetch(assetUrl(att.url)!)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => heifToJpeg(b))
      .then((jpeg) => URL.createObjectURL(jpeg))
      .catch(() => null);
    decoded.set(att.id, p);
  }
  return p;
}

/**
 * A HEIC the server kept as is — stored before 1.31.67 or sent "as a file" — on a browser that
 * cannot draw it (anything but Safari, the desktop app included). Decoded here; until then, and
 * if it cannot be, it is the file card it always was.
 */
export function HeicPhoto({ att }: { att: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void decode(att).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [att.id]);

  if (url !== null) {
    return (
      <div className="msg-photo">
        <img src={url} alt={jpegName(att.filename)} onClick={() => openLightbox(url, att.filename)} />
      </div>
    );
  }
  return (
    <div className="msg-file">
      <div className="msg-file-inner">
        <div className="msg-file-icon">📄</div>
        <div>
          <div className="msg-file-name">{att.filename}</div>
          <div className="msg-file-size">{formatFileSize(att.size)}</div>
        </div>
        <a className="msg-file-download" href={assetUrl(att.url)} download={att.filename} title={t("chat.download")}>⤓</a>
      </div>
    </div>
  );
}
