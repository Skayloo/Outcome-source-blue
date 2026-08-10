import { useEffect } from "react";
import { useStoreState } from "@lib/useStore";
import { lightboxStore, closeLightbox } from "@stores/lightbox.store";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";

/** Fullscreen image viewer. Click the backdrop or press Esc to close; the image itself doesn't close. */
export function ImageLightbox() {
  const { url, alt } = useStoreState(lightboxStore);

  useEffect(() => {
    if (!url) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeLightbox(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [url]);

  if (!url) return null;

  return (
    <div className="lightbox-overlay" onClick={closeLightbox}>
      <button className="lightbox-close" title={t("common.close")} onClick={closeLightbox}>
        <Icon name="x" size={22} />
      </button>
      <img className="lightbox-img" src={url} alt={alt} onClick={(e) => e.stopPropagation()} />
      <a
        className="lightbox-open"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        <Icon name="external-link" size={15} /> {t("chat.openOriginal")}
      </a>
    </div>
  );
}
