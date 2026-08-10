/**
 * Account settings tab — username inline edit, change password, user status,
 * two-factor authentication (TOTP enroll/disable), and delete account.
 * Ported from the deprecated Tauri client's AccountTab. Profile/password/2FA/
 * delete go through the REST api; status persists a pref AND broadcasts presence.
 */
import { useEffect, useRef, useState } from "react";
import { Section, Banner } from "@components/settings/controls";
import { Avatar } from "@components/Avatar";
import { loadPref, savePref } from "@components/settings/helpers";
import { api, wsSend } from "@lib/services";
import { authStore, updateUser } from "@stores/auth.store";
import { useStoreState } from "@lib/useStore";
import { logout } from "@lib/session";
import { SessionsList } from "@components/settings/SessionsList";
import { t } from "@lib/i18n";
import type { UserStatus } from "@lib/types";

const MAX_USERNAME_LEN = 32;
const MIN_USERNAME_LEN = 2;

interface StatusOption {
  readonly value: UserStatus;
  readonly labelKey: string;
  readonly descKey: string;
  readonly color: string;
}

// Labels/descriptions resolved through t() at render (empty descKey = no description).
const STATUS_OPTIONS: readonly StatusOption[] = [
  { value: "online", labelKey: "settings.statusOnline", descKey: "", color: "#3ba55d" },
  { value: "idle", labelKey: "settings.statusIdle", descKey: "settings.statusIdleDesc", color: "#faa61a" },
  { value: "dnd", labelKey: "settings.statusDnd", descKey: "settings.statusDndDesc", color: "#ed4245" },
  { value: "offline", labelKey: "settings.statusOffline", descKey: "settings.statusOfflineDesc", color: "#747f8d" },
];

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// ---------------------------------------------------------------------------
// Username inline edit
// ---------------------------------------------------------------------------

function UsernameSection({ username, avatar }: { username: string; avatar: string | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(username);
  const [error, setError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const open = () => {
    setValue(authStore.getState().user?.username ?? "");
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = () => {
    const newName = value.trim();
    if (newName.length < MIN_USERNAME_LEN || newName.length > MAX_USERNAME_LEN) {
      setError(t("settings.usernameLengthError", { min: MIN_USERNAME_LEN, max: MAX_USERNAME_LEN }));
      return;
    }
    setError(null);
    void api
      .updateProfile({ username: newName })
      .then(() => {
        updateUser({ username: newName });
        setEditing(false);
      })
      .catch((e: unknown) => setError(errMsg(e, t("settings.usernameUpdateFailed"))));
  };

  const pickAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAvatarError(null);
    setAvatarBusy(true);
    void api
      .uploadFile(file)
      .then((up) => api.updateProfile({ avatar: up.url }).then(() => up.url))
      .then((url) => {
        updateUser({ avatar: url });
        setAvatarBusy(false);
      })
      .catch((err: unknown) => {
        setAvatarError(errMsg(err, t("settings.usernameUpdateFailed")));
        setAvatarBusy(false);
      });
  };

  const removeAvatar = () => {
    setAvatarError(null);
    setAvatarBusy(true);
    void api
      .updateProfile({ avatar: "" })
      .then(() => {
        updateUser({ avatar: null });
        setAvatarBusy(false);
      })
      .catch((err: unknown) => {
        setAvatarError(errMsg(err, t("settings.usernameUpdateFailed")));
        setAvatarBusy(false);
      });
  };

  return (
    <div className="account-card">
      <div className="account-banner" />
      <div className="account-avatar-wrap">
        <Avatar username={username} avatar={avatar} size={80} color="#5865f2" />
        <div className="account-status-dot" />
      </div>
      <div className="account-header">
        <div className="account-header-name">{username}</div>
        {!editing && (
          <button className="ac-btn" onClick={open}>{t("settings.editUserProfile")}</button>
        )}
      </div>
      <div className="account-fields">
        <div className="account-field">
          <div>
            <div className="account-field-label">Avatar</div>
            <div className="account-field-value">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={pickAvatar}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="ac-btn" disabled={avatarBusy} onClick={() => fileRef.current?.click()}>
                  Change Avatar
                </button>
                {avatar && (
                  <button
                    className="ac-btn account-delete-btn"
                    disabled={avatarBusy}
                    onClick={removeAvatar}
                  >
                    {t("friends.remove")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {avatarError && <Banner kind="error">{avatarError}</Banner>}
      <div className="account-fields">
        <div className="account-field">
          <div>
            <div className="account-field-label">{t("settings.username")}</div>
            <div className="account-field-value">{username}</div>
          </div>
          {!editing && (
            <button className="account-field-edit" onClick={open}>{t("common.edit")}</button>
          )}
        </div>
      </div>
      {editing && (
        <div className="setting-row" style={{ display: "flex", marginTop: 12 }}>
          <input
            className="form-input"
            type="text"
            placeholder={t("settings.newUsername")}
            value={value}
            autoFocus
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
          />
          <button className="ac-btn" onClick={save}>{t("common.save")}</button>
          <button className="ac-btn" style={{ background: "var(--bg-active)" }} onClick={cancel}>{t("common.cancel")}</button>
          {error && <Banner kind="error">{error}</Banner>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status selector
// ---------------------------------------------------------------------------

function StatusSection() {
  const [current, setCurrent] = useState<UserStatus>(() => loadPref<UserStatus>("userStatus", "online"));

  const select = (status: UserStatus) => {
    setCurrent(status);
    savePref("userStatus", status);
    wsSend("presence_update", { status });
  };

  return (
    <>
      <Section title={t("settings.status")} />
      <div className="settings-status-options">
        {STATUS_OPTIONS.map((opt) => {
          const active = opt.value === current;
          return (
            <div
              key={opt.value}
              className={"settings-status-option" + (active ? " active" : "")}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              onClick={() => select(opt.value)}
              onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(opt.value);
                }
              }}
            >
              <div className="settings-status-dot" style={{ background: opt.color }} />
              <div>
                <div className="settings-status-label">{t(opt.labelKey)}</div>
                {opt.descKey.length > 0 && (
                  <div className="settings-status-desc">{t(opt.descKey)}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

function PasswordSection() {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const submit = () => {
    setSuccess(false);
    if (newPw.length < 8) {
      setError(t("settings.passwordTooShort"));
      return;
    }
    if (newPw !== confirmPw) {
      setError(t("settings.passwordsDoNotMatch"));
      return;
    }
    setError(null);
    void api
      .changePassword(oldPw, newPw)
      .then(() => {
        setOldPw("");
        setNewPw("");
        setConfirmPw("");
        setSuccess(true);
      })
      .catch((e: unknown) => setError(errMsg(e, t("settings.passwordChangeFailed"))));
  };

  return (
    <>
      <Section title={t("settings.passwordAndAuth")} />
      <input
        className="form-input"
        type="password"
        placeholder={t("settings.oldPassword")}
        style={{ marginBottom: 12 }}
        value={oldPw}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOldPw(e.target.value)}
      />
      <input
        className="form-input"
        type="password"
        placeholder={t("settings.newPassword")}
        style={{ marginBottom: 12 }}
        value={newPw}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPw(e.target.value)}
      />
      <input
        className="form-input"
        type="password"
        placeholder={t("settings.confirmNewPassword")}
        style={{ marginBottom: 12 }}
        value={confirmPw}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPw(e.target.value)}
      />
      {error && <Banner kind="error">{error}</Banner>}
      {success && <Banner kind="success">{t("settings.passwordChanged")}</Banner>}
      <button className="ac-btn" onClick={submit}>{t("settings.changePassword")}</button>
    </>
  );
}


// ---------------------------------------------------------------------------
// Two-factor authentication
// ---------------------------------------------------------------------------

function TotpEnroll() {
  const [stage, setStage] = useState<"idle" | "password" | "confirm">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enroll, setEnroll] = useState<{ qr_uri: string; backup_codes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const requestEnroll = () => {
    if (password.length === 0) {
      setError(t("settings.passwordRequired"));
      return;
    }
    setError(null);
    setBusy(true);
    void api
      .enableTotp(password)
      .then((result) => {
        setEnroll(result);
        setStage("confirm");
        setBusy(false);
      })
      .catch((e: unknown) => {
        setError(errMsg(e, t("settings.enable2faFailed")));
        setBusy(false);
      });
  };

  const confirm = () => {
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setError(t("settings.enterSixDigitCode"));
      return;
    }
    setError(null);
    setBusy(true);
    void api
      .confirmTotp(password, trimmed)
      .then(() => {
        updateUser({ totp_enabled: true });
      })
      .catch((e: unknown) => {
        setError(errMsg(e, t("settings.invalidVerificationCode")));
        setBusy(false);
      });
  };

  if (stage === "idle") {
    return (
      <>
        <Banner kind="info">{t("settings.twoFactorPromo")}</Banner>
        <button className="ac-btn" onClick={() => { setPassword(""); setError(null); setStage("password"); }}>
          {t("settings.enable2fa")}
        </button>
      </>
    );
  }

  if (stage === "password") {
    return (
      <>
        <input
          className="form-input"
          type="password"
          placeholder={t("settings.enterYourPassword")}
          style={{ marginBottom: 12 }}
          autoFocus
          value={password}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
        />
        {error && <Banner kind="error">{error}</Banner>}
        <button className="ac-btn" disabled={busy} onClick={requestEnroll}>
          {busy ? t("settings.requesting") : t("settings.submit")}
        </button>
      </>
    );
  }

  // stage === "confirm"
  return (
    <>
      <Banner kind="info">{t("settings.scanUri")}</Banner>
      <code
        style={{
          display: "block",
          background: "var(--bg-active)",
          padding: "8px 12px",
          borderRadius: 6,
          fontFamily: "monospace",
          fontSize: 12,
          wordBreak: "break-all",
          marginBottom: 12,
          color: "var(--text-primary)",
          userSelect: "all",
        }}
      >
        {enroll?.qr_uri}
      </code>
      {enroll && enroll.backup_codes.length > 0 && (
        <>
          <Banner kind="info">{t("settings.saveBackupCodes")}</Banner>
          <code
            style={{
              display: "block",
              background: "var(--bg-active)",
              padding: "8px 12px",
              borderRadius: 6,
              fontFamily: "monospace",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              marginBottom: 12,
              color: "var(--text-primary)",
              userSelect: "all",
            }}
          >
            {enroll.backup_codes.join("\n")}
          </code>
        </>
      )}
      <input
        className="form-input"
        type="text"
        placeholder={t("settings.sixDigitCode")}
        maxLength={6}
        style={{ marginBottom: 12 }}
        autoFocus
        value={code}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
      />
      {error && <Banner kind="error">{error}</Banner>}
      <button className="ac-btn" disabled={busy} onClick={confirm}>
        {busy ? t("settings.verifying") : t("settings.verifyAndActivate")}
      </button>
    </>
  );
}

function TotpDisable() {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const disable = () => {
    if (password.length === 0) {
      setError(t("settings.passwordRequired"));
      return;
    }
    setError(null);
    setBusy(true);
    void api
      .disableTotp(password)
      .then(() => {
        updateUser({ totp_enabled: false });
      })
      .catch((e: unknown) => {
        const msg = errMsg(e, t("settings.disable2faFailed"));
        setError(
          msg.toLowerCase().includes("required")
            ? t("settings.twoFactorRequired")
            : msg,
        );
        setBusy(false);
      });
  };

  return (
    <>
      <Banner kind="info">{t("settings.accountProtected2fa")}</Banner>
      {!confirming ? (
        <button className="ac-btn account-delete-btn" onClick={() => { setPassword(""); setError(null); setConfirming(true); }}>
          {t("settings.disable2fa")}
        </button>
      ) : (
        <>
          <input
            className="form-input"
            type="password"
            placeholder={t("settings.enterYourPassword")}
            style={{ marginBottom: 12 }}
            autoFocus
            value={password}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
          />
          {error && <Banner kind="error">{error}</Banner>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ac-btn account-delete-btn" disabled={busy} onClick={disable}>
              {busy ? t("settings.disabling") : t("settings.confirmDisable")}
            </button>
            <button
              className="ac-btn"
              style={{ background: "var(--bg-active)" }}
              onClick={() => { setConfirming(false); setPassword(""); setError(null); }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function TotpSection({ enabled }: { enabled: boolean }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Section title={t("settings.twoFactorAuth")} />
        <span
          style={{
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 4,
            fontWeight: 600,
            background: enabled ? "var(--green, #3ba55d)" : "var(--bg-active)",
            color: enabled ? "#fff" : "var(--text-muted)",
          }}
        >
          {enabled ? t("settings.enabled") : t("settings.disabled")}
        </span>
      </div>
      {enabled ? <TotpDisable /> : <TotpEnroll />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete account (danger zone)
// ---------------------------------------------------------------------------

function DeleteAccountSection() {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = () => {
    if (password.length === 0) {
      setError(t("settings.passwordRequired"));
      return;
    }
    setError(null);
    setBusy(true);
    void api
      .deleteAccount(password)
      .then(() => {
        logout();
      })
      .catch((e: unknown) => {
        setError(errMsg(e, t("settings.deleteAccountFailed")));
        setBusy(false);
      });
  };

  return (
    <>
      <Section title={t("settings.dangerZone")} />
      <Banner kind="info">{t("settings.deleteAccountPromo")}</Banner>
      {!confirming ? (
        <button className="ac-btn account-delete-btn" onClick={() => { setPassword(""); setError(null); setConfirming(true); }}>
          {t("settings.deleteAccount")}
        </button>
      ) : (
        <div className="account-delete-confirm">
          <Banner kind="error">
            {t("settings.deleteAccountWarning")}
          </Banner>
          <input
            className="form-input"
            type="password"
            placeholder={t("settings.enterYourPassword")}
            style={{ marginBottom: 12 }}
            autoFocus
            value={password}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
          />
          {error && <Banner kind="error">{error}</Banner>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ac-btn account-delete-btn" disabled={busy} onClick={remove}>
              {busy ? t("settings.deleting") : t("settings.confirmDelete")}
            </button>
            <button
              className="ac-btn"
              style={{ background: "var(--bg-active)" }}
              onClick={() => { setConfirming(false); setPassword(""); setError(null); }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------

export function AccountTab() {
  const { user } = useStoreState(authStore);
  const username = user?.username ?? t("settings.unknownUser");
  const totpEnabled = user?.totp_enabled === true;

  return (
    <div className="settings-pane active">
      <UsernameSection key={username} username={username} avatar={user?.avatar ?? null} />
      <StatusSection />
      <PasswordSection />
      <TotpSection enabled={totpEnabled} />
      <SessionsList />
      <DeleteAccountSection />
    </div>
  );
}
