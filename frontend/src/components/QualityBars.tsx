import { t } from "@lib/i18n";

/** Signal-strength bars for a voice participant, driven by the SFU's connection-quality
 *  feed (excellent / good / poor / lost). Renders nothing while quality is unknown. */
export function QualityBars({ quality, size = 12 }: { quality?: string; size?: number }) {
  if (!quality || quality === "unknown") return null;
  const level = quality === "excellent" ? 3 : quality === "good" ? 2 : quality === "poor" ? 1 : 0;
  const label =
    quality === "excellent" ? t("voice.qualityExcellent")
    : quality === "good" ? t("voice.qualityGood")
    : quality === "poor" ? t("voice.qualityPoor")
    : t("voice.qualityLost");
  return (
    <span
      className={`q-bars q-${quality}`}
      style={{ height: size, width: size }}
      title={label}
      aria-label={label}
    >
      {[1, 2, 3].map((i) => (
        <span key={i} className={"q-bar" + (i <= level ? " lit" : "")} style={{ height: `${28 + i * 24}%` }} />
      ))}
    </span>
  );
}
