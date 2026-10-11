/**
 * SpaceConsole — one tenant, full screen. Opened from the spaces list; everything here acts
 * INSIDE that space's database (its own users, its own servers, its own login branding and
 * SSO), which is why it reads as a separate console rather than a row that expands.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Banner } from "@components/settings/controls";
import { Avatar, Badge, Btn, Card, Empty } from "@components/admin/kit";
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

  const ssoField = (key: keyof SpaceSso, label: string, placeholder: string, type = "text") => (
    <label className="adm-field">
      <span>{label}</span>
      <input className="form-input mono" type={type} placeholder={placeholder} value={sso[key]} disabled={busy}
             onChange={(e) => setSso((prev) => ({ ...prev, [key]: e.target.value }))} />
    </label>
  );

  const TABS: { id: Tab; label: string }[] = [
    { id: "brand", label: t("admin.branding") },
    { id: "users", label: t("admin.users") },
    { id: "servers", label: t("admin.servers") },
    { id: "sso", label: "SSO" },
  ];

  const logo = icon
    ? <img className="space-logo-preview" src={icon} alt="" />
    : <span className="space-logo-preview empty">{name.slice(0, 1).toUpperCase()}</span>;

  return (
    <div className="settings-pane active space-console">
      <div className="adm-console-head">
        <Btn kind="ghost" size="sm" icon="arrow-left" onClick={onBack}>{t("admin.allSpaces")}</Btn>
        <div className="adm-console-title">
          {logo}
          <div>
            <div className="adm-cell-main">{name}</div>
            <div className="adm-cell-sub mono">{space.slug} · {space.db_name}</div>
          </div>
          {space.is_root && <Badge tone="accent">{t("admin.rootSpace")}</Badge>}
        </div>
        {saved && <Badge tone="success">{t("admin.saved")}</Badge>}
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="adm-tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={"adm-tab" + (tab === x.id ? " is-active" : "")} onClick={() => setTab(x.id)}>
            {x.label}
          </button>
        ))}
      </div>

      {tab === "brand" && (
        <>
          <Card title={t("admin.loginBranding")}>
            <div className="adm-brand-row">
              {logo}
              <label className="adm-field adm-field--grow">
                <span>{t("admin.spaceName")}</span>
                <input className="form-input" type="text" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
            <div className="adm-form-actions">
              <label className="adm-btn adm-btn--secondary adm-btn--sm">
                {t("admin.uploadLogo")}
                <input type="file" accept="image/*" hidden disabled={busy}
                       onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              {icon && <Btn kind="ghost" size="sm" disabled={busy} onClick={() => setIcon("")}>{t("admin.clearLogo")}</Btn>}
              <span className="adm-spacer" />
              <Btn kind="primary" disabled={busy || !name.trim()} onClick={saveBrand}>{busy ? t("admin.working") : t("admin.save")}</Btn>
            </div>
          </Card>
          <Card title={t("admin.domain")} desc={t("admin.domainHint")}>
            <form className="adm-inline-form" onSubmit={(e) => { e.preventDefault(); saveDomain(); }}>
              <input className="form-input mono" type="text" placeholder="coreotc.outcome.ru" value={domain} disabled={busy}
                     onChange={(e) => setDomain(e.target.value)} />
              <Btn type="submit" kind="secondary" disabled={busy}>{t("admin.save")}</Btn>
            </form>
          </Card>
        </>
      )}

      {tab === "users" && (
        users.length === 0 ? <Empty icon="users" title={t("admin.noMembers")} /> : (
          <table className="admin-table">
            <thead><tr><th>{t("admin.username")}</th><th>{t("admin.status")}</th><th>{t("admin.role")}</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="adm-cell-user">
                      <Avatar name={u.username} />
                      <div><div className="adm-cell-main">{u.username}</div>{u.email && <div className="adm-cell-email">{u.email}</div>}<div className="adm-cell-sub">ID {u.id}</div></div>
                    </div>
                  </td>
                  <td>
                    {u.banned ? <Badge tone="danger" dot>{t("admin.banned")}</Badge>
                      : <Badge tone={u.status === "online" ? "success" : "neutral"} dot>{u.status === "online" ? t("admin.online") : t("admin.offline")}</Badge>}
                  </td>
                  <td className="mono">{u.role_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "servers" && (
        servers.length === 0 ? <Empty icon="server" title={t("admin.noServers")} /> : (
          <table className="admin-table">
            <thead><tr><th>{t("admin.serverName")}</th><th>{t("admin.ownerId")}</th></tr></thead>
            <tbody>
              {servers.map((sv) => (
                <tr key={sv.id}>
                  <td>
                    <div className="adm-cell-user">
                      <Avatar name={sv.name} />
                      <div><div className="adm-cell-main">{sv.name}</div><div className="adm-cell-sub">ID {sv.id}</div></div>
                    </div>
                  </td>
                  <td className="mono">{sv.owner_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "sso" && (
        <Card title={t("admin.ssoTitle")} desc={t("admin.ssoDesc")}>
          <div className="adm-form-grid">
            {ssoField("google_client_id", "Google · client id", "client id")}
            {ssoField("google_client_secret", "Google · client secret", "client secret", "password")}
            {ssoField("yandex_client_id", "Yandex · client id", "client id")}
            {ssoField("yandex_client_secret", "Yandex · client secret", "client secret", "password")}
            {ssoField("email_domains", t("admin.ssoDomains"), "w3g.group")}
          </div>
          {sso.callback_base && (
            <p className="admin-note">
              {t("admin.ssoCallbackHint")}<br />
              <span className="mono">{sso.callback_base}/api/v1/auth/oauth/google/callback</span>
            </p>
          )}
          <div className="adm-form-actions">
            <span className="adm-spacer" />
            <Btn kind="primary" disabled={busy} onClick={saveSso}>{busy ? t("admin.working") : t("admin.save")}</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}
