import { useEffect, useState, type FormEvent } from "react";
import { api } from "@lib/services";
import { wirePostAuth } from "@lib/session";
import { ApiClientError } from "@lib/api";
import { BrandMark, useSpaceBrand } from "@components/BrandMark";
import { fetchSsoProviders, startSso, type SsoProvider } from "@lib/sso";
import { GoogleMark, YandexMark } from "@components/SsoMarks";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import { readLastHost } from "@lib/serverHost";

type Mode = "loading" | "login" | "register" | "setup" | "totp" | "regcode" | "forgot" | "reset";

export function ConnectPage() {
  const [mode, setMode] = useState<Mode>("loading");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [code, setCode] = useState("");
  const [partialToken, setPartialToken] = useState("");
  const [twoFactorMethod, setTwoFactorMethod] = useState("totp");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<SsoProvider[]>([]);
  // Instance-wide invite-only switch: the register form marks the invite field required
  // up front instead of letting the submit bounce off the server.
  const [inviteRequired, setInviteRequired] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Optional self-hosted instance picker: empty = the instance that served this page.
  // Prefilled (and revealed) with the last host the user signed into.
  const [host, setHost] = useState(readLastHost);
  const [showHost, setShowHost] = useState(() => readLastHost() !== "");
  // The host the setup/SSO probes were last run against — recommitted on field blur, so
  // the SSO buttons and the setup wizard reflect the TARGET instance, not this one.
  const [committedHost, setCommittedHost] = useState(readLastHost);
  // Tenant branding: on a customer's subdomain the login screen wears THEIR name and logo,
  // not ours. Null on the main domain (and on any host no space claims) → Outcome branding.
  const brand = useSpaceBrand();

  useEffect(() => {
    // Aim the shared API client at the picked instance before probing it.
    api.setConfig({ host: committedHost });
    api.getSetupStatus()
      .then((s) => { setMode((m) => (m === "loading" || m === "setup" || m === "login") ? (s.needs_setup ? "setup" : "login") : m); setInviteRequired(s.invite_required === true); })
      .catch(() => setMode((m) => (m === "loading" ? "login" : m)));
    // Render a provider button only when the server actually holds its keys.
    void fetchSsoProviders().then(setSsoProviders);
  }, [committedHost]);

  function fail(e: unknown) {
    setError(e instanceof ApiClientError || e instanceof Error ? e.message : t("auth.requestFailed"));
    setBusy(false);
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    if (mode === "register" && inviteRequired && invite.trim().length === 0) {
      setError(t("auth.inviteRequired"));
      return;
    }
    setBusy(true);
    const targetHost = host.trim();
    try {
      // The field may have been edited without blurring — make sure every call below
      // (and the WS that follows auth) targets the picked instance.
      api.setConfig({ host: targetHost });
      if (targetHost !== committedHost) setCommittedHost(targetHost);
      if (targetHost) {
        // Fail fast with a clear message when the instance is unreachable — otherwise the
        // login call surfaces a generic network error after a long fetch timeout.
        try {
          await api.getHealth(targetHost);
        } catch {
          setError(t("auth.serverUnreachable"));
          setBusy(false);
          return;
        }
      }
      if (mode === "setup") {
        const r = await api.setup(email, username, password);
        wirePostAuth(targetHost, r.token, r.username);
      } else if (mode === "register") {
        const r = await api.register(email, username, password, invite);
        // Email verification on: the account does not exist yet — the server parked the
        // registration and mailed a code. Swap to the code screen; submit completes it.
        if (r.requires_email_verify && r.partial_token) {
          setPartialToken(r.partial_token);
          setMode("regcode");
          setBusy(false);
          return;
        }
        if (r.token) wirePostAuth(targetHost, r.token, username);
      } else if (mode === "regcode") {
        const r = await api.verifyRegistration(code, partialToken);
        if (r.token) wirePostAuth(targetHost, r.token, username);
      } else if (mode === "forgot") {
        // Always advances to the code screen — the server answers 204 whether or not the
        // address exists, so the UI must not branch on it (no account-enumeration signal).
        await api.forgotPassword(email);
        setCode("");
        setMode("reset");
        setBusy(false);
        return;
      } else if (mode === "reset") {
        const r = await api.resetPassword(email, code, password);
        if (r.token) wirePostAuth(targetHost, r.token, email);
      } else if (mode === "totp") {
        const r = twoFactorMethod === "email"
          ? await api.verifyEmailOtp(code, partialToken)
          : await api.verifyTotp(code, partialToken);
        if (r.token) wirePostAuth(targetHost, r.token, username || email);
      } else {
        const r = await api.login(email, password);
        if (r.requires_2fa) {
          setPartialToken(r.partial_token ?? "");
          setTwoFactorMethod(r.two_factor_method ?? "totp");
          setMode("totp");
          setBusy(false);
          return;
        }
        if (r.token) wirePostAuth(targetHost, r.token, email);
      }
    } catch (e) {
      fail(e);
    }
  }

  const title = mode === "setup" ? t("auth.titleSetup")
    : mode === "register" ? t("auth.titleRegister")
    : mode === "regcode" ? t("auth.titleRegCode")
    : mode === "forgot" ? t("auth.titleForgot")
    : mode === "reset" ? t("auth.titleReset")
    : mode === "totp" ? (twoFactorMethod === "email" ? t("auth.titleEmailCode") : t("auth.titleTwoFactor"))
    : t("auth.titleLogin");
  const needsUsername = mode === "setup" || mode === "register";

  return (
    <div className="connect-page">
      <div className="server-panel">
        <div className="server-branding">
          <BrandMark brand={brand} width={80} />
          <div className="brand-name">{brand?.name ?? "Outcome"}</div>
          <div className="brand-tagline">{t("auth.tagline")}</div>
        </div>
      </div>

      <div className="form-panel">
        <div className="form-container">
          <div className="form-logo">
            <BrandMark brand={brand} width={70} />
            <h1>{brand?.name ?? "Outcome"}</h1>
            <p>{title}</p>
          </div>

          {error && <div className="error-banner visible" role="alert">{error}</div>}

          <form className="connect-form" onSubmit={submit} noValidate>
            {mode === "totp" || mode === "regcode" ? (
              <div className="form-group">
                <label className="form-label" htmlFor="code">
                  {mode === "regcode" || twoFactorMethod === "email" ? t("auth.labelEmailCode") : t("auth.labelAuthCode")}
                </label>
                <input className="form-input" id="code" inputMode="numeric" autoComplete="one-time-code"
                  placeholder="000000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
                {(mode === "regcode" || twoFactorMethod === "email") && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                    {t("auth.emailCodeHint")}
                  </div>
                )}
              </div>
            ) : mode === "forgot" ? (
              <div className="form-group">
                <label className="form-label" htmlFor="email">{t("auth.labelEmail")}</label>
                <input className="form-input" id="email" type="email" autoComplete="email"
                  placeholder={t("auth.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
                <div className="form-hint">{t("auth.forgotHint")}</div>
              </div>
            ) : mode === "reset" ? (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="code">{t("auth.labelEmailCode")}</label>
                  <input className="form-input" id="code" inputMode="numeric" autoComplete="one-time-code"
                    placeholder="000000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
                  <div className="form-hint">{t("auth.resetCodeHint", { email })}</div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="password">{t("auth.labelNewPassword")}</label>
                  <div className="password-field">
                    <input className="form-input" id="password" type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={password} onChange={(e) => setPassword(e.target.value)} />
                    <button type="button" className="password-reveal" tabIndex={-1}
                      aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                      title={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                      onClick={() => setShowPassword((v) => !v)}>
                      <Icon name={showPassword ? "eye-off" : "eye"} size={18} />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="email">{t("auth.labelEmail")}</label>
                  <input className="form-input" id="email" type="email" autoComplete="email"
                    placeholder={t("auth.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
                </div>
                {needsUsername && (
                  <div className="form-group">
                    <label className="form-label" htmlFor="username">{t("auth.labelUsername")}</label>
                    <input className="form-input" id="username" autoComplete="username"
                      value={username} onChange={(e) => setUsername(e.target.value)} />
                  </div>
                )}
                <div className="form-group">
                  <label className="form-label" htmlFor="password">{t("auth.labelPassword")}</label>
                  <div className="password-field">
                    <input className="form-input" id="password" type={showPassword ? "text" : "password"}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      value={password} onChange={(e) => setPassword(e.target.value)} />
                    <button type="button" className="password-reveal" tabIndex={-1}
                      aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                      title={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                      onClick={() => setShowPassword((v) => !v)}>
                      <Icon name={showPassword ? "eye-off" : "eye"} size={18} />
                    </button>
                  </div>
                </div>
                {mode === "register" && (
                  <div className="form-group">
                    <label className="form-label" htmlFor="invite">
                      {inviteRequired ? t("auth.labelInvite") : t("auth.labelInviteOptional")}
                    </label>
                    <input className="form-input" id="invite" value={invite}
                      placeholder={inviteRequired ? t("auth.inviteRequiredPlaceholder") : t("auth.invitePlaceholder")}
                      onChange={(e) => setInvite(e.target.value)} />
                    <div className="form-hint">
                      {inviteRequired ? t("auth.inviteRequired") : t("auth.inviteHint")}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Optional instance picker — this SPA can sign into any self-hosted Outcome
                server, not just the one that served it (same idea as a Matrix homeserver
                field). Hidden behind a toggle; commit on blur re-probes setup/SSO. */}
            {(mode === "login" || mode === "register") && showHost && (
              <div className="form-group">
                <label className="form-label" htmlFor="server">{t("auth.labelServer")}</label>
                <input className="form-input" id="server" autoCorrect="off" autoCapitalize="none"
                  spellCheck={false} placeholder={t("auth.serverPlaceholder")} value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onBlur={() => setCommittedHost(host.trim())} />
                <div className="form-hint">{t("auth.serverHint")}</div>
              </div>
            )}

            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? t("auth.btnBusy")
                : mode === "setup" ? t("auth.btnCreateOwner")
                : mode === "register" ? t("auth.btnRegister")
                : mode === "forgot" ? t("auth.btnSendCode")
                : mode === "reset" ? t("auth.btnResetPassword")
                : mode === "totp" || mode === "regcode" ? t("auth.btnVerify")
                : t("auth.btnLogin")}
            </button>

            {/* "Forgot password?" — the entry into the email-code reset. Also the ONLY path an
                SSO-only account has to gain a password (and the rescue for accounts whose SSO
                provider was later disabled). Back-link returns to login from either step. */}
            {mode === "login" && (
              <button type="button" className="form-toggle-action" style={{ marginTop: 12 }}
                onClick={() => { setError(null); setPassword(""); setMode("forgot"); }}>
                {t("auth.forgotLink")}
              </button>
            )}
            {(mode === "forgot" || mode === "reset") && (
              <button type="button" className="form-toggle-action" style={{ marginTop: 12 }}
                onClick={() => { setError(null); setCode(""); setMode("login"); }}>
                {t("auth.backToLogin")}
              </button>
            )}
          </form>

          {/* SSO only makes sense for signing in / signing up — not for the owner-setup
              wizard (there is no account yet to own the instance) or the 2FA step. */}
          {(mode === "login" || mode === "register") && ssoProviders.length > 0 && (
            <>
              <div className="sso-divider"><span>{t("auth.ssoOr")}</span></div>
              <div className="sso-buttons">
                {ssoProviders.includes("google") && (
                  <button type="button" className="btn-sso" disabled={busy}
                    onClick={() => startSso("google", host.trim())}>
                    <GoogleMark /> {t("auth.ssoGoogle")}
                  </button>
                )}
                {ssoProviders.includes("yandex") && (
                  <button type="button" className="btn-sso" disabled={busy}
                    onClick={() => startSso("yandex", host.trim())}>
                    <YandexMark /> {t("auth.ssoYandex")}
                  </button>
                )}
              </div>
              {/* Invite-only blocks NEW SSO accounts server-side; warn up front on the
                  register tab instead of bouncing the user off the provider round-trip. */}
              {inviteRequired && mode === "register" && (
                <div className="form-hint" style={{ marginTop: 8, textAlign: "center" }}>
                  {t("auth.ssoInviteOnlyHint")}
                </div>
              )}
            </>
          )}

          {(mode === "login" || mode === "register") && (
            <div className="form-toggle-link">
              {mode === "login" ? t("auth.toggleToRegisterPrefix") : t("auth.toggleToLoginPrefix")}{" "}
              <button
                type="button"
                className="form-toggle-action"
                onClick={() => { setError(null); setMode(mode === "login" ? "register" : "login"); }}
              >
                {mode === "login" ? t("auth.toggleToRegisterAction") : t("auth.toggleToLoginAction")}
              </button>
            </div>
          )}

          {(mode === "login" || mode === "register") && (
            <div className="form-toggle-link">
              <button
                type="button"
                className="form-toggle-action"
                onClick={() => {
                  if (showHost) { setHost(""); setCommittedHost(""); }
                  setShowHost((v) => !v);
                }}
              >
                {showHost ? t("auth.hideServer") : t("auth.changeServer")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
