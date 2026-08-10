/**
 * Server Settings pane (admin). Loads the server's key/value settings via
 * api.getAdminSettings() and lets an admin edit them. server_name and motd get
 * dedicated controls (text input / textarea); every other returned key renders
 * as a generic editable input so unknown keys are still editable and robust.
 * Saving PATCHes only the changed keys via api.updateAdminSettings().
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Section, Row, Toggle, Banner } from "@components/settings/controls";
import { t } from "@lib/i18n";
import { api } from "@lib/services";

const PRIMARY_KEYS = ["server_name", "motd"] as const;
// Boolean switches that get dedicated Toggle rows (stored as "1"/"0" strings server-side).
const REGISTRATION_KEYS = ["registration_open", "registration_invite_only", "registration_email_verify"] as const;

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Humanize a settings key for use as a label (e.g. "max_upload_mb" -> "Max Upload Mb"). */
function labelFor(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function ServerSettingsPanel() {
  // Original values from the server (source of truth for the diff).
  const [original, setOriginal] = useState<Record<string, string>>({});
  // Current editable values.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    void api
      .getAdminSettings(controller.signal)
      .then((settings) => {
        if (!mountedRef.current) return;
        setOriginal(settings);
        setDraft(settings);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setError(errMsg(e, t("admin.failedLoadServerSettings")));
        setLoading(false);
      });

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, []);

  // Keys other than the dedicated-control ones, stable sorted.
  const extraKeys = useMemo(() => {
    const dedicated = new Set<string>([...PRIMARY_KEYS, ...REGISTRATION_KEYS]);
    return Object.keys(original)
      .filter((k) => !dedicated.has(k))
      .sort((a, b) => a.localeCompare(b));
  }, [original]);

  // Diff: only keys whose draft value differs from the original.
  const changed = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const key of Object.keys(draft)) {
      const next = draft[key] ?? "";
      const prev = original[key] ?? "";
      if (next !== prev) out[key] = next;
    }
    return out;
  }, [draft, original]);

  const dirty = Object.keys(changed).length > 0;

  const setField = (key: string, value: string) => {
    setSaved(false);
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const save = () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    const controller = new AbortController();
    void api
      .updateAdminSettings(changed, controller.signal)
      .then((result) => {
        if (!mountedRef.current) return;
        // The server echoes back the (full or partial) updated settings — merge
        // so original reflects the persisted truth and the diff resets.
        setOriginal((prev) => ({ ...prev, ...changed, ...result }));
        setDraft((prev) => ({ ...prev, ...changed, ...result }));
        setSaving(false);
        setSaved(true);
      })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        setError(errMsg(e, t("admin.failedSaveServerSettings")));
        setSaving(false);
      });
  };

  const serverName = draft["server_name"] ?? "";
  const motd = draft["motd"] ?? "";
  const hasServerName = "server_name" in original;
  const hasMotd = "motd" in original;

  return (
    <div className="settings-pane active">
      <Section title={t("admin.serverSettings")} />

      {loading ? (
        <Banner kind="info">{t("admin.loadingServerSettings")}</Banner>
      ) : (
        <>
          {(hasServerName || hasMotd) && (
            <>
              {hasServerName && (
                <div style={{ marginBottom: 16 }}>
                  <div className="setting-label">{t("admin.serverName")}</div>
                  <div className="setting-desc" style={{ marginBottom: 8 }}>
                    {t("admin.serverNameDesc")}
                  </div>
                  <input
                    className="form-input"
                    type="text"
                    value={serverName}
                    placeholder={t("admin.serverNamePlaceholder")}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setField("server_name", e.target.value)
                    }
                  />
                </div>
              )}

              {hasMotd && (
                <div style={{ marginBottom: 16 }}>
                  <div className="setting-label">{t("admin.motd")}</div>
                  <div className="setting-desc" style={{ marginBottom: 8 }}>
                    {t("admin.motdDesc")}
                  </div>
                  <textarea
                    className="form-input"
                    value={motd}
                    placeholder={t("admin.motdPlaceholder")}
                    rows={3}
                    style={{ resize: "vertical", minHeight: 72 }}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                      setField("motd", e.target.value)
                    }
                  />
                </div>
              )}
            </>
          )}

          <Section title={t("admin.registration")} />
          <Row label={t("admin.regOpen")} desc={t("admin.regOpenDesc")}>
            <Toggle
              on={(draft["registration_open"] ?? "1") === "1"}
              onChange={(v) => setField("registration_open", v ? "1" : "0")}
            />
          </Row>
          {/* The keys may be absent until first toggled — treat missing as OFF (open registration). */}
          <Row label={t("admin.regInviteOnly")} desc={t("admin.regInviteOnlyDesc")}>
            <Toggle
              on={(draft["registration_invite_only"] ?? "0") === "1"}
              onChange={(v) => setField("registration_invite_only", v ? "1" : "0")}
            />
          </Row>
          <Row label={t("admin.regEmailVerify")} desc={t("admin.regEmailVerifyDesc")}>
            <Toggle
              on={(draft["registration_email_verify"] ?? "0") === "1"}
              onChange={(v) => setField("registration_email_verify", v ? "1" : "0")}
            />
          </Row>

          {extraKeys.length > 0 && (
            <>
              <Section title={t("admin.advanced")} />
              {extraKeys.map((key) => (
                <div key={key} style={{ marginBottom: 16 }}>
                  <div className="setting-label">{labelFor(key)}</div>
                  <input
                    className="form-input"
                    type="text"
                    value={draft[key] ?? ""}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setField(key, e.target.value)
                    }
                  />
                </div>
              ))}
            </>
          )}

          {Object.keys(original).length === 0 && (
            <Banner kind="info">{t("admin.noEditableSettings")}</Banner>
          )}

          {error && <Banner kind="error">{error}</Banner>}
          {saved && !dirty && <Banner kind="success">{t("admin.settingsSaved")}</Banner>}

          <button
            className="ac-btn"
            style={{ marginTop: 8 }}
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? t("admin.saving") : t("admin.saveChanges")}
          </button>
        </>
      )}
    </div>
  );
}
