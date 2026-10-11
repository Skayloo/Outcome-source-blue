/**
 * Server Settings pane (admin). Loads the server's key/value settings via
 * api.getAdminSettings() and lets an admin edit them. server_name and motd get
 * dedicated controls (text input / textarea); every other returned key renders
 * as a generic editable input so unknown keys are still editable and robust.
 * Saving PATCHes only the changed keys via api.updateAdminSettings().
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Row, Toggle, Banner } from "@components/settings/controls";
import { Btn, Card, Spinner } from "@components/admin/kit";
import { t } from "@lib/i18n";
import { api } from "@lib/services";

const PRIMARY_KEYS = ["server_name", "motd"] as const;
// Boolean switches that get dedicated Toggle rows. This panel writes "1"/"0", but it is not the
// only writer, and the server reads "true"/"false" just as happily — see AuthRules.ParseBoolean.
const REGISTRATION_KEYS = ["registration_open", "registration_invite_only", "registration_email_verify",
  "registration_pdn_consent"] as const;

/**
 * Read a stored setting the way the SERVER reads it. Comparing `value === "1"` looked equivalent
 * and was not: `registration_email_verify` is stored as "true", so the switch drew itself OFF
 * while the feature was ON — and the next save on this page wrote that lie back as "0". A
 * setting that silently disables itself is worse than one that never worked.
 */
function isOn(value: string | undefined, fallback: boolean): boolean {
  switch ((value ?? "").trim().toLowerCase()) {
    case "1": case "true": return true;
    case "0": case "false": return false;
    default: return fallback;
  }
}

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
      {loading ? (
        <div className="adm-loading"><Spinner size={20} /></div>
      ) : (
        <>
          {(hasServerName || hasMotd) && (
            <Card title={t("admin.general")}>
              {hasServerName && (
                <label className="adm-field">
                  <span>{t("admin.serverName")}</span>
                  <input
                    className="form-input"
                    type="text"
                    value={serverName}
                    placeholder={t("admin.serverNamePlaceholder")}
                    onChange={(e) => setField("server_name", e.target.value)}
                  />
                  <small>{t("admin.serverNameDesc")}</small>
                </label>
              )}
              {hasMotd && (
                <label className="adm-field">
                  <span>{t("admin.motd")}</span>
                  <textarea
                    className="form-input"
                    value={motd}
                    placeholder={t("admin.motdPlaceholder")}
                    rows={3}
                    onChange={(e) => setField("motd", e.target.value)}
                  />
                  <small>{t("admin.motdDesc")}</small>
                </label>
              )}
            </Card>
          )}

          <Card title={t("admin.registration")}>
            <div className="adm-rows-settings">
              <Row label={t("admin.regOpen")} desc={t("admin.regOpenDesc")}>
                <Toggle
                  on={isOn(draft["registration_open"], true)}
                  onChange={(v) => setField("registration_open", v ? "1" : "0")}
                />
              </Row>
              {/* The keys may be absent until first toggled — treat missing as OFF (open registration). */}
              <Row label={t("admin.regInviteOnly")} desc={t("admin.regInviteOnlyDesc")}>
                <Toggle
                  on={isOn(draft["registration_invite_only"], false)}
                  onChange={(v) => setField("registration_invite_only", v ? "1" : "0")}
                />
              </Row>
              <Row label={t("admin.regEmailVerify")} desc={t("admin.regEmailVerifyDesc")}>
                <Toggle
                  on={isOn(draft["registration_email_verify"], false)}
                  onChange={(v) => setField("registration_email_verify", v ? "1" : "0")}
                />
              </Row>
              {/* OFF by default: the obligation belongs to whoever operates the space, and this
                  server ships to people who operate their own. ON for outcome.ru. */}
              <Row label={t("admin.regPdnConsent")} desc={t("admin.regPdnConsentDesc")}>
                <Toggle
                  on={isOn(draft["registration_pdn_consent"], false)}
                  onChange={(v) => setField("registration_pdn_consent", v ? "1" : "0")}
                />
              </Row>
            </div>
          </Card>

          {extraKeys.length > 0 && (
            <Card title={t("admin.advanced")}>
              <div className="adm-form-grid adm-form-grid--2">
                {extraKeys.map((key) => (
                  <label key={key} className="adm-field">
                    <span>{labelFor(key)}</span>
                    <input className="form-input" type="text" value={draft[key] ?? ""} onChange={(e) => setField(key, e.target.value)} />
                  </label>
                ))}
              </div>
            </Card>
          )}

          {Object.keys(original).length === 0 && (
            <Banner kind="info">{t("admin.noEditableSettings")}</Banner>
          )}

          {error && <Banner kind="error">{error}</Banner>}
          {saved && !dirty && <Banner kind="success">{t("admin.settingsSaved")}</Banner>}

          {/* The commit control follows the scroll once anything is unsaved.
              It used to sit at the bottom of a page a screen and a half long, while the
              switches it commits sit at the top — so flipping "email verification" off, then
              reloading, brought it back ON, and the panel looked like it was refusing to save.
              Nothing was refused: nothing had been sent. A switch reads as applied the moment
              it moves, so the thing that applies it cannot be somewhere the eye never goes. */}
          {dirty && (
            <div className="adm-savebar">
              <span>{t("admin.unsavedChanges")}</span>
              <span className="adm-spacer" />
              <Btn kind="ghost" disabled={saving} onClick={() => setDraft(original)}>{t("admin.discardChanges")}</Btn>
              <Btn kind="primary" icon="check" disabled={saving} onClick={save}>
                {saving ? t("admin.saving") : t("admin.saveChanges")}
              </Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
}
