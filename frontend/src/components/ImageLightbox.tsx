import { useEffect, useState } from "react";
import { useStoreState } from "@lib/useStore";
import { lightboxStore, closeLightbox, stepLightbox } from "@stores/lightbox.store";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";

/**
 * Fullscreen image viewer. Click the backdrop or press Esc to close; the image itself doesn't
 * close. A message that carried several pictures opens as an album — arrows and the left/right
 * keys move within it, the same way the phone browses one.
 */
export function ImageLightbox() {
  const { items, index } = useStoreState(lightboxStore);
  const current = items[index];

  // What is actually painted. Stepping to the next picture only changes `src`, and a browser
  // keeps the OLD image on screen until the new one has decoded — several seconds for a photo
  // of a few megabytes. The name in the corner switches instantly, so the viewer sits there
  // showing the previous photo under the next one's name, and two different pictures look
  // like one repeated. Start from the thumbnail the album already cached — right picture,
  // straight away — and swap to the full size once it is decoded and can be drawn at once.
  // Which url has finished decoding — never "is it loaded", which would still be true for the
  // one before it. Derived at render from `current`, so the very first frame after a step is
  // already the right picture instead of the previous one.
  const [decoded, setDecoded] = useState<string | null>(null);
  const sharp = !current?.thumb || decoded === current.url;
  const src = (sharp ? current?.url : current.thumb) ?? "";

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    const full = new Image();
    full.src = current.url;
    // decode() resolves when the bytes are ready to paint; without it the swap can still land
    // on an undecoded image and flash.
    void full.decode().catch(() => undefined).then(() => {
      if (!cancelled) setDecoded(current.url);
    });
    return () => { cancelled = true; };
  }, [current?.url]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") stepLightbox(-1);
      else if (e.key === "ArrowRight") stepLightbox(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current) return null;

  const many = items.length > 1;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="lightbox-overlay" onClick={closeLightbox}>
      <button className="lightbox-close" title={t("common.close")} onClick={closeLightbox}>
        <Icon name="x" size={22} />
      </button>

      {many && index > 0 && (
        <button className="lightbox-nav prev" title={t("chat.prevPhoto")}
          onClick={(e) => { stop(e); stepLightbox(-1); }}>
          {/* No left chevron in the set — the right one, mirrored. */}
          <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
            <Icon name="chevron-right" size={26} />
          </span>
        </button>
      )}

      {/* Keyed by the item so stepping REPLACES the element instead of re-pointing it — a
          reused <img> is exactly what holds the previous photo on screen. */}
      <img key={current.url} className={"lightbox-img" + (sharp ? "" : " loading")}
        src={src} alt={current.alt} onClick={stop} />

      {many && index < items.length - 1 && (
        <button className="lightbox-nav next" title={t("chat.nextPhoto")}
          onClick={(e) => { stop(e); stepLightbox(1); }}>
          <Icon name="chevron-right" size={26} />
        </button>
      )}

      {/* Number AND name. Five screenshots of the same screen look identical at a glance, and
          without something to tell them apart "it showed me the same photo twice" is
          indistinguishable from "these two photos look alike". */}
      {many && (
        <div className="lightbox-count" onClick={stop}>
          {index + 1} / {items.length}
          {current.alt ? <span className="lightbox-name">{current.alt}</span> : null}
        </div>
      )}

      <a
        className="lightbox-open"
        href={current.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={stop}
      >
        <Icon name="external-link" size={15} /> {t("chat.openOriginal")}
      </a>
    </div>
  );
}
