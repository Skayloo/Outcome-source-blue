import { useEffect, useState } from "react";
import { desktop } from "@lib/desktop";
import { voiceStore } from "@stores/voice.store";
import { confirm } from "@components/ConfirmDialog";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";

/**
 * "Update ready" in the header's corner, as Discord does it: the desktop shell has downloaded a
 * new version, one click restarts into it. Before this the only doors were the tray menu and
 * quitting the app — and a messenger is almost never quit, so updates sat downloaded for weeks.
 * Renders nothing in a browser and until an update is waiting.
 */
export function UpdateButton() {
  // null = nothing waiting; "" = waiting, version unknown.
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const shell = desktop();
    if (!shell?.updateState || !shell.onUpdateReady) return;
    let alive = true;
    // It may have finished downloading before this page was up.
    void shell.updateState().then((s) => { if (alive && s.ready) setVersion(s.version); });
    const off = shell.onUpdateReady((v) => setVersion(v));
    return () => { alive = false; off(); };
  }, []);

  if (version === null) return null;

  async function restart(): Promise<void> {
    // The restart ends the call for everyone listening to us — say so rather than drop it.
    if (voiceStore.getState().currentChannelId != null) {
      const ok = await confirm({
        title: t("update.title"),
        message: t("update.inCall"),
        confirmLabel: t("update.restart"),
      });
      if (!ok) return;
    }
    await desktop()?.installUpdate?.();
  }

  return (
    <button
      className="update-ready-btn"
      title={version ? t("update.tooltipVersion", { version }) : t("update.tooltip")}
      onClick={() => void restart()}
    >
      <Icon name="download" size={16} />
      <span>{t("update.restart")}</span>
    </button>
  );
}
