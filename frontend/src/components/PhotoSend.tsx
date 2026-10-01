import { useEffect, useRef } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";

export interface SendPhoto {
  readonly key: number;
  readonly preview: string | null;
  readonly filename: string;
  readonly progress: number;
  readonly uploaded: boolean;
}

/**
 * Telegram's "send photo" step: the pictures as they will go, a caption, Send. Crop and draw are
 * one click away on each picture and never open by themselves — most photos go as they are.
 *
 * The caption IS the composer's text: typed here or there, it is the same message, and backing
 * out keeps it.
 */
export function PhotoSend({ photos, caption, onCaption, onEdit, onRemove, onSend, onCancel }: {
  photos: readonly SendPhoto[];
  caption: string;
  onCaption: (v: string) => void;
  onEdit: (key: number, mode: "crop" | "draw") => void;
  onRemove: (key: number) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  // Back in the caption after an edit replaced a picture, so Enter sends.
  const keys = photos.map((p) => p.key).join();
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [keys]);

  // Escape anywhere in the dialog, not only in the caption. The editor opened over this one
  // stops the key in the capture phase, so it never reaches here while it is up.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cancel.current(); } };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const uploading = photos.filter((p) => !p.uploaded);
  const pct = uploading.length
    ? Math.round(uploading.reduce((s, p) => s + p.progress, 0) / uploading.length)
    : 100;

  return (
    <ModalPortal>
      <div className="ps-overlay" onMouseDown={onCancel}>
        <div className="ps-card" role="dialog" aria-modal="true"
          aria-label={photos.length === 1 ? t("photoSend.one") : t("photoSend.many", { n: photos.length })}
          onMouseDown={(e) => e.stopPropagation()}>
          <div className="ps-head">
            <button className="ps-icon" onClick={onCancel} title={t("photoEditor.cancel")} aria-label={t("photoEditor.cancel")}>
              <Icon name="x" size={20} />
            </button>
            <span className="ps-title">
              {photos.length === 1 ? t("photoSend.one") : t("photoSend.many", { n: photos.length })}
            </span>
          </div>

          <div className={"ps-media" + (photos.length > 1 ? " grid" : "")}>
            {photos.map((p) => (
              <figure className="ps-item" key={p.key}>
                {p.preview && <img src={p.preview} alt={p.filename} />}
                {!p.uploaded && (
                  <span className="att-progress"><span className="att-progress-bar" style={{ width: `${p.progress}%` }} /></span>
                )}
                <div className="ps-tools">
                  <button onClick={() => onEdit(p.key, "crop")} title={t("photoEditor.crop")} aria-label={t("photoEditor.crop")}>
                    <Icon name="crop" size={17} />
                  </button>
                  <button onClick={() => onEdit(p.key, "draw")} title={t("photoEditor.draw")} aria-label={t("photoEditor.draw")}>
                    <Icon name="brush" size={17} />
                  </button>
                  <button onClick={() => onRemove(p.key)} title={t("photoSend.remove")} aria-label={t("photoSend.remove")}>
                    <Icon name="trash-2" size={17} />
                  </button>
                </div>
              </figure>
            ))}
          </div>

          <div className="ps-foot">
            <textarea
              ref={ta}
              className="ps-caption"
              rows={1}
              placeholder={t("photoSend.caption")}
              value={caption}
              onChange={(e) => onCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
              }}
            />
            {/* Send is never blocked by an upload: pressed early, the message goes the moment
                the last photo lands. The percentage is only there to say why it has not yet. */}
            <button className="ps-send" onClick={onSend}>
              {uploading.length ? `${t("photoSend.send")} · ${pct}%` : t("photoSend.send")}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
