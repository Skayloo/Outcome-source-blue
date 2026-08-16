import { useEffect, useState } from "react";
import { api } from "@lib/services";
import { BootSplash } from "@components/BootSplash";
import { t } from "@lib/i18n";

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
    setError(null);
    setBusy(true);
    // The current password is ignored by the server when there is none to prove — see
    // ChangePasswordHandler. Sent empty rather than faked.
    void api.changePassword("", pw)
      .then(() => setMode("none"))
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
            <button className="btn-primary" type="submit"
              disabled={busy || pw.length < 8 || pw !== confirm}>
              {busy ? t("setPassword.saving") : t("setPassword.save")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
