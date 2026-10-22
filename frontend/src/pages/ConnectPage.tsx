import { useEffect, useState, type FormEvent } from "react";
import { api } from "@lib/services";
import { wirePostAuth } from "@lib/session";
import { setSidebarMode } from "@stores/ui.store";
import { PDN_CONSENT_VERSION, PDN_CONSENT_URL, PDN_POLICY_URL, pdnConsentApplies } from "@lib/pdnConsent";
import { ApiClientError } from "@lib/api";
import { BrandMark, useSpaceBrand } from "@components/BrandMark";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import { readLastHost } from "@lib/serverHost";

type Mode = "loading" | "login" | "register" | "setup" | "totp";

/** Every sign-in on this page ends here. */
function signedIn(host: string, token: string, username: string): void {
  wirePostAuth(host, token, username);
}

/** A brand-new account opens IN the server registration gave it (its own one, or the invite's)
 *  rather than on the direct messages — which a new account has none of, so that was an empty
 *  page (the owner, 2026-10-16). The UI store outlives a sign-out in the same tab, so a
 *  previous session left in the DM view would otherwise carry over. */
function signedUp(host: string, token: string, username: string): void {
  setSidebarMode("channels");
  signedIn(host, token, username);
}

export function ConnectPage() {
  const [mode, setMode] = useState<Mode>("loading");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  // Personal-data consent. Unchecked by default and never pre-ticked: a consent the
  // person did not actively give is not consent, and 152-ФЗ says so out loud.
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [partialToken, setPartialToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Instance-wide invite-only switch: the register form marks the invite field required
  // up front instead of letting the submit bounce off the server.
  const [inviteRequired, setInviteRequired] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Optional self-hosted instance picker: empty = the instance that served this page.
  // Prefilled (and revealed) with the last host the user signed into.
  const [host, setHost] = useState(readLastHost);
  const [showHost, setShowHost] = useState(() => readLastHost() !== "");
  // The host the setup probe was last run against — recommitted on field blur, so the setup
  // wizard reflects the TARGET instance, not this one.
  const [committedHost, setCommittedHost] = useState(readLastHost);
  // Whether to ask at all. Derived from the host the form is pointed at, so it appears and
  // disappears as that field changes — no round trip, and the same rule the phone applies.
  const askConsent = pdnConsentApplies(committedHost);

  // Tenant branding: on a customer's subdomain the login screen wears THEIR name and logo,
  // not ours. Null on the main domain (and on any host no space claims) → Outcome branding.
  const brand = useSpaceBrand();

  useEffect(() => {
    // Aim the shared API client at the picked instance before probing it.
    api.setConfig({ host: committedHost });
    api.getSetupStatus()
      .then((s) => { setMode((m) => (m === "loading" || m === "setup" || m === "login") ? (s.needs_setup ? "setup" : "login") : m); setInviteRequired(s.invite_required === true); })
      .catch(() => setMode((m) => (m === "loading" ? "login" : m)));
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
        signedIn(targetHost, r.token, r.username);
      } else if (mode === "register") {
        // Empty where we are not the operator: claiming a consent nobody gave is worse
        // than recording none. A self-hosted server that requires one refuses this.
        const r = await api.register(email, username, password, invite,
          askConsent ? PDN_CONSENT_VERSION : "");
        if (r.token) signedUp(targetHost, r.token, username);
      } else if (mode === "totp") {
        const r = await api.verifyTotp(code, partialToken);
        if (r.token) signedIn(targetHost, r.token, username || email);
      } else {
        const r = await api.login(email, password);
        if (r.requires_2fa) {
          setPartialToken(r.partial_token ?? "");
          setMode("totp");
          setBusy(false);
          return;
        }
        if (r.token) signedIn(targetHost, r.token, email);
      }
    } catch (e) {
      fail(e);
    }
  }

  const title = mode === "setup" ? t("auth.titleSetup")
    : mode === "register" ? t("auth.titleRegister")
    : mode === "totp" ? t("auth.titleTwoFactor")
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
            {mode === "totp" ? (
              <div className="form-group">
                <label className="form-label" htmlFor="code">{t("auth.labelAuthCode")}</label>
                <input className="form-input" id="code" inputMode="numeric" autoComplete="one-time-code"
                  placeholder="000000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              </div>
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
                {mode === "register" && askConsent && (
                  <>
                    {/* The consent, and ONLY the consent. Since 156-ФЗ (in force 1 Sep 2025) it
                        has to stand apart from every other document a person accepts — folding
                        "and I accept the policy" into the same sentence is the bundling the law
                        was written to stop, and a caption under the button instead of a box is
                        named outright as not enough. */}
                    <label className="form-consent">
                      <input type="checkbox" checked={consent}
                        onChange={(e) => setConsent(e.target.checked)} />
                      <span>
                        {t("auth.consentBefore")}{" "}
                        <a href={PDN_CONSENT_URL} target="_blank" rel="noopener">
                          {t("auth.consentLink")}
                        </a>
                        {t("auth.consentAfter")}
                      </span>
                    </label>
                    {/* Informational, deliberately outside the label: the policy is something the
                        operator publishes, not something the person agrees to. */}
                    <div className="form-hint">
                      {t("auth.consentPolicy")}{" "}
                      <a href={PDN_POLICY_URL} target="_blank" rel="noopener">
                        {t("auth.consentPolicyLink")}
                      </a>
                    </div>
                  </>
                )}
              </>
            )}

            {/* Optional instance picker — this SPA can sign into any self-hosted Outcome
                server, not just the one that served it (same idea as a Matrix homeserver
                field). Hidden behind a toggle; commit on blur re-probes setup. */}
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

            <button className="btn-primary" type="submit"
              disabled={busy || (mode === "register" && askConsent && !consent)}>
              {busy ? t("auth.btnBusy")
                : mode === "setup" ? t("auth.btnCreateOwner")
                : mode === "register" ? t("auth.btnRegister")
                : mode === "totp" ? t("auth.btnVerify")
                : t("auth.btnLogin")}
            </button>

            {mode === "login" && (
              <div className="form-hint" style={{ marginTop: 12, textAlign: "center" }}>
                {t("auth.forgotAskAdmin")}
              </div>
            )}
          </form>

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
