/**
 * SpaceConsole — one tenant, full screen. Opened from the spaces list; everything here acts
 * INSIDE that space's database (its own users, its own servers, its own login branding and
 * SSO), which is why it reads as a separate console rather than a row that expands.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Icon } from "@lib/icons";
import { Banner } from "@components/settings/controls";
import type { AdminSpace, AdminUserResponse, SpaceServer, SpaceSso } from "@lib/types";

function errMsg(e: unknown, f: string): string { return e instanceof Error ? e.message : f; }

type Tab = "brand" | "users" | "servers" | "sso";

const EMPTY_SSO: SpaceSso = {
  google_client_id: "", google_client_secret: "",
  yandex_client_id: "", yandex_client_secret: "",
  email_domains: "", callback_base: "",
};

export function SpaceConsole({ space, onBack, onChanged }: {
  space: AdminSpace;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("brand");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState(space.name);
  const [icon, setIcon] = useState("");
  const [domain, setDomain] = useState(space.domain ?? "");
  const [users, setUsers] = useState<readonly AdminUserResponse[]>([]);
  const [servers, setServers] = useState<readonly SpaceServer[]>([]);
  const [sso, setSso] = useState<SpaceSso>(EMPTY_SSO);

  const run = useCallback((p: Promise<unknown>, after?: () => void): void => {
    setBusy(true);
    setError(null);
    void p.then(() => { after?.(); setSaved(true); window.setTimeout(() => setSaved(false), 2000); })
      .catch((e: unknown) => setError(errMsg(e, t("admin.actionFailed"))))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const fail = (e: unknown) => { if (!ac.signal.aborted) setError(errMsg(e, t("admin.actionFailed"))); };
    if (tab === "brand") void api.adminSpaceBranding(space.id, ac.signal).then((b) => { setName(b.name); setIcon(b.icon); }).catch(fail);
    if (tab === "users") void api.adminSpaceUsers(space.id, ac.signal).then(setUsers).catch(fail);
    if (tab === "servers") void api.adminSpaceServers(space.id, ac.signal).then(setServers).catch(fail);
    if (tab === "sso") void api.adminSpaceSso(space.id, ac.signal).then(setSso).catch(fail);
    return () => ac.abort();
  }, [tab, space.id]);

  const saveBrand = (): void => {
    if (!name.trim()) return;
    run(api.adminSetSpaceBranding(space.id, { name: name.trim(), icon }), onChanged);
  };

  const saveDomain = (): void => {
    run(api.adminUpdateSpace(space.id, { domain: domain.trim() }), onChanged);
  };

  // Read inline instead of uploading: an upload is stored in the MAIN instance's files, and
  // the tenant's login page resolves file URLs against its own database, where that row does
  // not exist. A logo is small enough to live in the space's settings.
  const pickLogo = (file: File | undefined): void => {
    if (!file) return;
    if (file.size > 512 * 1024) { setError(t("admin.logoTooLarge")); return; }
    const reader = new FileReader();
    reader.onload = () => setIcon(String(reader.result));
    reader.onerror = () => setError(t("admin.actionFailed"));
    reader.readAsDataURL(file);
  };

  const saveSso = (): void => {
    run(api.adminSetSpaceSso(space.id, {
      google_client_id: sso.google_client_id,
      google_client_secret: sso.google_client_secret,
      yandex_client_id: sso.yandex_client_id,
      yandex_client_secret: sso.yandex_client_secret,
      email_domains: sso.email_domains,
    }));
  };

  const ssoField = (key: keyof SpaceSso, placeholder: string, type = "text") => (
    <input className="form-input mono" type={type} placeholder={placeholder} value={sso[key]} disabled={busy}
           onChange={(e) => setSso((prev) => ({ ...prev, [key]: e.target.value }))} />
  );

  const TABS: { id: Tab; label: string }[] = [
    { id: "brand", label: t("admin.branding") },
    { id: "users", label: t("admin.users") },
    { id: "servers", label: t("admin.servers") },
    { id: "sso", label: "SSO" },
  ];

  return (
    <div className="settings-pane active space-console">
      <div className="admin-toolbar">
        <button className="ac-btn" onClick={onBack}><Icon name="arrow-right" size={15} /> {t("admin.allSpaces")}</button>
        <span className="space-console-title">
          {icon ? <img className="space-logo-preview" src={icon} alt="" /> : <span className="space-logo-preview empty">{name.slice(0, 1).toUpperCase()}</span>}
          <b>{name}</b>
          <span className="mono dimmed">{space.slug} · {space.db_name}</span>
        </span>
        <span className="spacer" />
        {saved && <span className="dimmed">{t("admin.saved")}</span>}
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="admin-toolbar space-console-tabs">
        {TABS.map((x) => (
          <button key={x.id} className={"ac-btn" + (tab === x.id ? " on" : "")} onClick={() => setTab(x.id)}>{x.label}</button>
        ))}
      </div>

      {tab === "brand" && (
        <>
          <div className="admin-perms-title">{t("admin.loginBranding")}</div>
          <div className="admin-toolbar">
            {icon ? <img className="space-logo-preview" src={icon} alt="" />
                  : <span className="space-logo-preview empty">{name.slice(0, 1).toUpperCase()}</span>}
            <input className="form-input" type="text" placeholder={t("admin.spaceName")} value={name} disabled={busy}
                   onChange={(e) => setName(e.target.value)} />
            <label className="ac-btn">
              {t("admin.uploadLogo")}
              <input type="file" accept="image/*" hidden disabled={busy}
                     onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {icon && <button className="ac-btn" disabled={busy} onClick={() => setIcon("")}>{t("admin.clearLogo")}</button>}
            <button className="ac-btn" disabled={busy || !name.trim()} onClick={saveBrand}>
              {busy ? t("admin.working") : t("admin.save")}
            </button>
          </div>

          <div className="admin-perms-title">{t("admin.domain")}</div>
          <div className="admin-toolbar">
            <input className="form-input mono" type="text" placeholder="coreotc.outcome.ru" value={domain} disabled={busy}
                   onChange={(e) => setDomain(e.target.value)} />
            <button className="ac-btn" disabled={busy} onClick={saveDomain}>{t("admin.save")}</button>
          </div>
        </>
      )}

      {tab === "users" && (
        users.length === 0 ? <Banner kind="info">{t("admin.noMembers")}</Banner> : (
          <table className="admin-table">
            <thead><tr><th>ID</th><th>{t("admin.username")}</th><th>{t("admin.status")}</th><th>{t("admin.role")}</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.id}</td>
                  <td>{u.username}</td>
                  <td>{u.banned ? t("admin.banned") : u.status}</td>
                  <td className="mono">{u.role_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "servers" && (
        servers.length === 0 ? <Banner kind="info">{t("admin.noServers")}</Banner> : (
          <table className="admin-table">
            <thead><tr><th>ID</th><th>{t("admin.serverName")}</th><th>{t("admin.ownerId")}</th></tr></thead>
            <tbody>
              {servers.map((sv) => (
                <tr key={sv.id}>
                  <td className="mono">{sv.id}</td>
                  <td>{sv.name}</td>
                  <td className="mono">{sv.owner_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "sso" && (
        <>
          <div className="admin-perms-title">Google</div>
          <div className="admin-toolbar">
            {ssoField("google_client_id", "client id")}
            {ssoField("google_client_secret", "client secret", "password")}
          </div>
          <div className="admin-perms-title">Yandex</div>
          <div className="admin-toolbar">
            {ssoField("yandex_client_id", "client id")}
            {ssoField("yandex_client_secret", "client secret", "password")}
          </div>
          <div className="admin-perms-title">{t("admin.ssoDomains")}</div>
          <div className="admin-toolbar">
            {ssoField("email_domains", "w3g.group")}
            <button className="ac-btn" disabled={busy} onClick={saveSso}>{busy ? t("admin.working") : t("admin.save")}</button>
          </div>
          {sso.callback_base && (
            <Banner kind="info">
              {t("admin.ssoCallbackHint")}<br />
              <span className="mono">{sso.callback_base}/api/v1/auth/oauth/google/callback</span>
            </Banner>
          )}
        </>
      )}
    </div>
  );
}
