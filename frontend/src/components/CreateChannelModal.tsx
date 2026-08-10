import { useState, type CSSProperties } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { setTransientError } from "@stores/ui.store";
import type { ChannelType } from "@lib/types";

const overlay: CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.6)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};
const modal: CSSProperties = {
  width: 440, maxWidth: "92vw", background: "var(--bg-primary)",
  border: "1px solid var(--border)", borderRadius: 12, padding: 24, color: "var(--text-normal)",
};

export function CreateChannelModal({ category, onClose }: { category: string | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelType>("text");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.adminCreateChannel({ name: name.trim(), type, category: category ?? "Text Channels" });
      onClose();
    } catch (e) {
      setTransientError(e instanceof Error ? e.message : t("admin.failedCreateChannel"));
      setBusy(false);
    }
  }

  return (
    <ModalPortal>
      <div style={overlay} onClick={onClose}>
        <div style={modal} onClick={(e) => e.stopPropagation()}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "white", marginBottom: 20 }}>{t("admin.createChannel")}</h2>
          <div className="form-group">
            <label className="form-label">{t("admin.category")}</label>
            <input className="form-input" value={category ?? "Text Channels"} disabled />
          </div>
          <div className="form-group">
            <label className="form-label">{t("admin.name")}</label>
            <input className="form-input" autoFocus placeholder={t("admin.channelNamePlaceholder")} value={name}
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
          </div>
          <div className="form-group">
            <label className="form-label">{t("admin.type")}</label>
            <select className="form-input" value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
              <option value="text">{t("admin.typeText")}</option>
              <option value="voice">{t("admin.typeVoice")}</option>
            </select>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button className="input-btn" onClick={onClose} style={{ width: "auto", padding: "0 14px" }}>{t("admin.cancel")}</button>
            <button className="btn-primary" disabled={busy} onClick={create} style={{ width: "auto" }}>{t("admin.createChannel")}</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
