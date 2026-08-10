import { useEffect, useState, type CSSProperties } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { api } from "@lib/services";
import { setActiveChannel } from "@stores/channels.store";
import { formatTime } from "@lib/format";
import type { SearchResultItem } from "@lib/types";
import { t } from "@lib/i18n";

const overlay: CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.6)",
  display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 80, zIndex: 1000,
};
const panel: CSSProperties = {
  width: 560, maxWidth: "92vw", maxHeight: "70vh", overflowY: "auto",
  background: "var(--bg-primary)", border: "1px solid var(--border)",
  borderRadius: 12, padding: 16, color: "var(--text-normal)",
};

export function SearchOverlay({ initialQuery, onClose }: { initialQuery: string; onClose: () => void }) {
  const [results, setResults] = useState<readonly SearchResultItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.search(initialQuery, { limit: 25 })
      .then((r) => { if (!cancelled) { setResults(r.results); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialQuery]);

  return (
    <ModalPortal>
      <div style={overlay} onClick={onClose}>
        <div style={panel} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <strong>{t("chat.searchResultsFor", { query: initialQuery })}</strong>
            <button className="input-btn" onClick={onClose}>✕</button>
          </div>
          {loading ? (
            <div style={{ color: "var(--text-muted)" }}>{t("chat.searching")}</div>
          ) : results.length === 0 ? (
            <div style={{ color: "var(--text-muted)" }}>{t("chat.noResults")}</div>
          ) : results.map((r) => (
            <div
              key={r.message_id}
              className="member-item"
              style={{ display: "block", padding: "10px 12px", borderRadius: 8, marginBottom: 4 }}
              onClick={() => { setActiveChannel(r.channel_id); onClose(); }}
            >
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                <span style={{ color: "white", fontWeight: 600 }}>{r.user.username}</span> {t("chat.searchResultMeta", { channel: r.channel_name, time: formatTime(r.timestamp) })}
              </div>
              <div style={{ marginTop: 2 }}>{r.content}</div>
            </div>
          ))}
        </div>
      </div>
    </ModalPortal>
  );
}
