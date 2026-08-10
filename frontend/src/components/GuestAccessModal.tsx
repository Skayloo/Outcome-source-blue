/**
 * "Guest access" — the server-management window (NOT the admin console) that shows the
 * external-entry code for each voice channel: a link anyone can open without an account to
 * land in that channel's call. One active link per channel; revoking rotates it, so a code
 * that leaked somewhere you didn't intend can be killed and re-minted in two clicks.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { copyText } from "@lib/clipboard";
import { confirm } from "@components/ConfirmDialog";
import { setTransientSuccess } from "@stores/ui.store";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import { Banner } from "@components/settings/controls";
import type { GuestLinkRow } from "@lib/types";

function errMsg(e: unknown, f: string): string {
  return e instanceof Error ? e.message : f;
}

export function GuestAccessModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<GuestLinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const load = useCallback((signal?: AbortSignal): void => {
    void api
      .getGuestLinks(signal)
      .then((list) => { setRows(list); setError(null); })
      .catch((e: unknown) => { if (!signal?.aborted) { setError(errMsg(e, t("guestAccess.loadFailed"))); setRows([]); } });
  }, []);

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { c.abort(); window.removeEventListener("keydown", onKey); };
  }, [load, onClose]);

  useEffect(() => {
    if (copied === null) return;
    const id = window.setTimeout(() => setCopied(null), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);

  const create = (row: GuestLinkRow): void => {
    setBusy(row.channel_id);
    setError(null);
    void api
      .createGuestLink(row.channel_id)
      .then((r) => setRows((prev) => (prev ?? []).map((x) =>
        x.channel_id === row.channel_id ? { ...x, code: r.code, url: r.url } : x)))
      .catch((e: unknown) => setError(errMsg(e, t("guestAccess.createFailed"))))
      .finally(() => setBusy(null));
  };

  const revoke = async (row: GuestLinkRow): Promise<void> => {
    if (!(await confirm({
      message: t("guestAccess.revokeConfirm", { channel: row.channel_name }),
      highlight: row.channel_name,
      danger: true,
      confirmLabel: t("guestAccess.revoke"),
    }))) return;
    setBusy(row.channel_id);
    setError(null);
    void api
      .revokeGuestLink(row.channel_id)
      .then(() => setRows((prev) => (prev ?? []).map((x) =>
        x.channel_id === row.channel_id ? { ...x, code: null, url: null } : x)))
      .catch((e: unknown) => setError(errMsg(e, t("guestAccess.revokeFailed"))))
      .finally(() => setBusy(null));
  };

  const copy = (row: GuestLinkRow): void => {
    if (row.url === null) return;
    void copyText(row.url).then((ok) => {
      if (ok) { setCopied(row.channel_id); setTransientSuccess(t("guestAccess.copied")); }
      else setError(t("guestAccess.copyFailed"));
    });
  };

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div
        className="settings-panel"
        style={{ width: 640, height: "auto", maxHeight: "80vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-content" style={{ maxWidth: "none" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h1>{t("guestAccess.title")}</h1>
            <button className="settings-close-btn" title={t("admin.closeEsc")} onClick={onClose}>
              <Icon name="x" size={18} />
            </button>
          </div>

          <div className="setting-desc" style={{ marginBottom: 14 }}>{t("guestAccess.desc")}</div>

          {error && <Banner kind="error">{error}</Banner>}

          {rows === null ? (
            <Banner kind="info">{t("guestAccess.loading")}</Banner>
          ) : rows.length === 0 ? (
            <Banner kind="info">{t("guestAccess.noVoiceChannels")}</Banner>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((row) => (
                <div key={row.channel_id} className="guest-link-row">
                  <div className="guest-link-main">
                    <div className="guest-link-channel">
                      <Icon name="volume-2" size={15} /> {row.channel_name}
                    </div>
                    {row.url !== null ? (
                      <div className="guest-link-url" title={row.url}>{row.url}</div>
                    ) : (
                      <div className="setting-desc">{t("guestAccess.noLink")}</div>
                    )}
                  </div>

                  <div className="guest-link-actions">
                    {row.url !== null ? (
                      <>
                        <button className="ac-btn" disabled={busy === row.channel_id} onClick={() => copy(row)}>
                          <Icon name={copied === row.channel_id ? "check" : "send"} size={14} />
                          {copied === row.channel_id ? t("guestAccess.copiedShort") : t("guestAccess.copy")}
                        </button>
                        <button
                          className="ac-btn account-delete-btn"
                          disabled={busy === row.channel_id}
                          onClick={() => void revoke(row)}
                        >
                          <Icon name="trash-2" size={14} /> {t("guestAccess.revoke")}
                        </button>
                      </>
                    ) : (
                      <button className="ac-btn" disabled={busy === row.channel_id} onClick={() => create(row)}>
                        <Icon name="user-plus" size={14} />
                        {busy === row.channel_id ? t("guestAccess.creating") : t("guestAccess.create")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
