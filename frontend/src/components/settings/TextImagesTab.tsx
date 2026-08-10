/**
 * Text & Images settings tab — link previews, embeds, inline media, GIF animation.
 * Ported from the deprecated Tauri client's TextImagesTab. Each row just persists
 * its preference (consumed by the message renderer).
 */
import { ToggleRow } from "@components/settings/controls";
import { t } from "@lib/i18n";

export function TextImagesTab() {
  return (
    <div className="settings-pane active">
      <ToggleRow
        label={t("settings.linkPreview")}
        desc={t("settings.linkPreviewDesc")}
        k="showLinkPreviews"
        def={true}
      />
      <ToggleRow
        label={t("settings.showEmbeds")}
        desc={t("settings.showEmbedsDesc")}
        k="showEmbeds"
        def={true}
      />
      <ToggleRow
        label={t("settings.inlineMedia")}
        desc={t("settings.inlineMediaDesc")}
        k="inlineMedia"
        def={true}
      />
      <ToggleRow
        label={t("settings.animateGifs")}
        desc={t("settings.animateGifsDesc")}
        k="animateGifs"
        def={true}
      />
    </div>
  );
}
