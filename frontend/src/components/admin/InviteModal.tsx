import { useEffect } from "react";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import { InviteManager } from "@components/admin/InviteManager";

/** Standalone invite modal — accessible to moderators+ who may not have full admin access. */
export function InviteModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div
        className="settings-panel"
        style={{ width: 620, height: "auto", maxHeight: "80vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-content" style={{ maxWidth: "none" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h1>{t("admin.invitePeople")}</h1>
            <button className="settings-close-btn" title={t("admin.closeEsc")} onClick={onClose}><Icon name="x" size={18} /></button>
          </div>
          <InviteManager />
        </div>
      </div>
    </div>
  );
}
