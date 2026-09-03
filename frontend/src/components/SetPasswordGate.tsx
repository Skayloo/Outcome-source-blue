import { useEffect, useState } from "react";
import { api } from "@lib/services";
import { PDN_CONSENT_VERSION, PDN_CONSENT_URL, PDN_POLICY_URL, pdnConsentApplies } from "@lib/pdnConsent";
import { readLastHost } from "@lib/serverHost";
import { BootSplash } from "@components/BootSplash";
import { t } from "@lib/i18n";
import { createLogger } from "@lib/logger";

const log = createLogger("set-password");

/**
 * Signing in through a provider used to leave the account without a password of its own —
 * the row carried a random one nobody had ever seen, and the iOS app, which has no
 * third-party sign-in at all, could then not get into the account from a phone. This gate
 * asks for a password straight after a provider sign-in and does not hand over the app
 * until it is set.
 */
type Mode = "none" | "set";

export function SetPasswordGate({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode | null>(null);
  // Personal-data consent, asked HERE for provider-created accounts: they exist before anyone
  // was asked anything, and clicking a provider button is not agreement to our processing.
  const [consent, setConsent] = useState(false);
  // Same rule as the sign-up form: whether to ask at all is a question about the host, not
  // about the build.
  const askConsent = pdnConsentApplies(readLastHost());
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    void api.getMe(c.signal)
      .then((me) => {
        // Absent on older servers ⇒ the account has a password; never gate on a missing field.
        setMode(me.password_set === false ? "set" : "none");
      })
      .catch(() => setMode("none"));
    return () => c.abort();
  }, []);

  if (mode === null) return <BootSplash />;
  if (mode === "none") return <>{children}</>;

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (pw.length < 8) { setError(t("setPassword.tooShort")); return; }
    if (pw !== confirm) { setError(t("setPassword.mismatch")); return; }
    if (mode === "set" && askConsent && !consent) return; // the button is disabled too
    setError(null);
    setBusy(true);
    // The current password is ignored by the server when there is none to prove — see
    // ChangePasswordHandler. Sent empty rather than faked.
    void api.changePassword("", pw)
      .then(async () => {
        // After the password, so a failure here cannot leave the account unusable — and
        // best-effort, because the tick was given whether or not the write lands. The server
        // ignores a repeat, so a retry on the next sign-in costs nothing.
        if (askConsent) {
          try { await api.recordConsent(PDN_CONSENT_VERSION); }
          catch (err) { log.warn("could not record the personal-data consent", err); }
        }
        setMode("none");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("setPassword.failed")))
      .finally(() => setBusy(false));
  };

  return (
    <div className="connect-page">
      <div className="form-panel">
        <div className="form-container">
          <div className="form-logo">
            <h1>{t("setPassword.title")}</h1>
            <p>{t("setPassword.why")}</p>
          </div>

          {error && <div className="error-banner visible" role="alert">{error}</div>}

          <form className="connect-form" onSubmit={submit} noValidate>
            <div className="form-group">
              <label className="form-label" htmlFor="new-password">{t("setPassword.new")}</label>
              <input className="form-input" id="new-password" type="password" autoComplete="new-password"
                autoFocus value={pw} onChange={(ev) => setPw(ev.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="confirm-password">{t("setPassword.confirm")}</label>
              <input className="form-input" id="confirm-password" type="password" autoComplete="new-password"
                value={confirm} onChange={(ev) => setConfirm(ev.target.value)} />
              {/* Said while you type, not after you press the button — you are looking at the
                  field you just filled in, which is where the answer belongs. Silent until
                  there is something to compare against. */}
              {confirm.length > 0 && confirm !== pw && (
                <div className="form-hint" style={{ color: "var(--red, #f04747)" }}>
                  {t("setPassword.mismatch")}
                </div>
              )}
            </div>
            {/* The consent, and only the consent — separate from every other document, which is
                what 156-ФЗ requires. The policy sits under it as information, not as something
                being accepted. */}
            {askConsent && (<>
            <label className="form-consent">
              <input type="checkbox" checked={consent}
                onChange={(ev) => setConsent(ev.target.checked)} />
              <span>
                {t("auth.consentBefore")}{" "}
                <a href={PDN_CONSENT_URL} target="_blank" rel="noopener">
                  {t("auth.consentLink")}
                </a>
                {t("auth.consentAfter")}
              </span>
            </label>
            <div className="form-hint" style={{ marginBottom: 14 }}>
              {t("auth.consentPolicy")}{" "}
              <a href={PDN_POLICY_URL} target="_blank" rel="noopener">
                {t("auth.consentPolicyLink")}
              </a>
            </div>
            </>)}
            <button className="btn-primary" type="submit"
              disabled={busy || pw.length < 8 || pw !== confirm || (askConsent && !consent)}>
              {busy ? t("setPassword.saving") : t("setPassword.save")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
