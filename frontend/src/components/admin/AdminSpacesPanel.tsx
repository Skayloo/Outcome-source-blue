/**
 * AdminSpacesPanel — the control plane, and only ever on the main instance. A SPACE is a
 * tenant: its own database, users, servers and login page. Creating one here provisions the
 * database and (if asked) seeds its first administrator, so a new customer is one form away
 * from a working subdomain.
 *
 * Managing an existing one happens in SpaceConsole — a separate console, because everything
 * there acts inside that tenant's database rather than this one.
 */
import { useCallback, useEffect, useState } from "react";
import { confirm } from "@components/ConfirmDialog";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Banner } from "@components/settings/controls";
import { Avatar, Badge, Btn, Card, Empty, IconBtn, RowMenu, Spacer, Toolbar } from "@components/admin/kit";
import { SpaceConsole } from "@components/admin/SpaceConsole";
import type { AdminSpace } from "@lib/types";

function errMsg(e: unknown, f: string): string { return e instanceof Error ? e.message : f; }

export function AdminSpacesPanel() {
  const [spaces, setSpaces] = useState<readonly AdminSpace[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPass, setOwnerPass] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.adminListSpaces(signal);
      if (!signal?.aborted) setSpaces(list);
    } catch (e: unknown) {
      if (!signal?.aborted) setError(errMsg(e, t("admin.actionFailed")));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const run = (p: Promise<unknown>, after: () => void): void => {
    setBusy(true);
    setError(null);
    void p.then(after)
      .catch((e: unknown) => setError(errMsg(e, t("admin.actionFailed"))))
      .finally(() => setBusy(false));
  };

  const create = (): void => {
    if (!slug.trim() || !name.trim()) return;
    run(api.adminCreateSpace({
      slug: slug.trim(), name: name.trim(), domain: domain.trim() || undefined,
      owner_email: ownerEmail.trim() || undefined,
      owner_username: ownerName.trim() || undefined,
      owner_password: ownerPass || undefined,
    }), () => {
      setSlug(""); setName(""); setDomain("");
      setOwnerEmail(""); setOwnerName(""); setOwnerPass("");
      setCreating(false);
      void load();
    });
  };

  const toggleActive = (s: AdminSpace): void => {
    run(api.adminUpdateSpace(s.id, { active: !s.active }), () => void load());
  };

  const remove = async (s: AdminSpace): Promise<void> => {
    if (!(await confirm({ message: t("admin.deleteSpaceConfirm", { name: s.name }), danger: true, highlight: s.name }))) return;
    run(api.adminDeleteSpace(s.id), () => { setOpenId(null); void load(); });
  };

  const open = spaces.find((s) => s.id === openId);
  if (open) {
    return <SpaceConsole space={open} onBack={() => setOpenId(null)} onChanged={() => void load()} />;
  }

  return (
    <div className="settings-pane active">
      <Toolbar>
        <span className="adm-count">{t("admin.spacesTotal", { count: spaces.length })}</span>
        <Spacer />
        <IconBtn icon="refresh-cw" label={t("admin.refresh")} disabled={busy || loading} onClick={() => void load()} />
        {!creating && <Btn kind="primary" icon="plus" onClick={() => setCreating(true)}>{t("admin.newSpace")}</Btn>}
      </Toolbar>

      {error && <Banner kind="error">{error}</Banner>}

      {creating && (
        <Card title={t("admin.newSpace")} desc={t("admin.spacesHint")}
          actions={<IconBtn icon="x" label={t("admin.cancel")} onClick={() => setCreating(false)} />}>
          <form className="adm-form-grid" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <label className="adm-field">
              <span>{t("admin.spaceSlug")}</span>
              <input className="form-input mono" type="text" placeholder="core_otc" value={slug} disabled={busy}
                     onChange={(e) => setSlug(e.target.value)} />
            </label>
            <label className="adm-field">
              <span>{t("admin.spaceName")}</span>
              <input className="form-input" type="text" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="adm-field">
              <span>{t("admin.domain")}</span>
              <input className="form-input mono" type="text" placeholder="coreotc.outcome.ru" value={domain} disabled={busy}
                     onChange={(e) => setDomain(e.target.value)} />
            </label>
            <label className="adm-field">
              <span>{t("admin.ownerEmail")}</span>
              <input className="form-input" type="email" value={ownerEmail} disabled={busy} onChange={(e) => setOwnerEmail(e.target.value)} />
            </label>
            <label className="adm-field">
              <span>{t("admin.ownerUsername")}</span>
              <input className="form-input" type="text" value={ownerName} disabled={busy} onChange={(e) => setOwnerName(e.target.value)} />
            </label>
            <label className="adm-field">
              <span>{t("admin.ownerPassword")}</span>
              <input className="form-input" type="password" value={ownerPass} disabled={busy}
                     autoComplete="new-password" onChange={(e) => setOwnerPass(e.target.value)} />
            </label>
            <div className="adm-form-actions">
              <Btn type="submit" kind="primary" icon="plus" disabled={busy || !slug.trim() || !name.trim()}>
                {busy ? t("admin.working") : t("admin.createSpace")}
              </Btn>
            </div>
          </form>
        </Card>
      )}

      {spaces.length === 0 && !loading ? (
        <Empty icon="globe" title={t("admin.noSpaces")} />
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("admin.spaceName")}</th>
              <th>{t("admin.domain")}</th>
              <th className="adm-num">{t("admin.users")}</th>
              <th className="adm-num">{t("admin.servers")}</th>
              <th>{t("admin.status")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {spaces.map((s) => (
              <tr key={s.id} className={s.active ? undefined : "dimmed"}>
                <td>
                  <div className="adm-cell-user">
                    <Avatar name={s.name} />
                    <div>
                      <div className="adm-cell-main">{s.name}</div>
                      <div className="adm-cell-sub mono">{s.slug}</div>
                    </div>
                  </div>
                </td>
                <td className="mono">{s.domain ?? "—"}</td>
                <td className="adm-num">{s.user_count}</td>
                <td className="adm-num">{s.server_count}</td>
                <td>
                  {s.is_root
                    ? <Badge tone="accent">{t("admin.rootSpace")}</Badge>
                    : s.active ? <Badge tone="success" dot>{t("admin.active")}</Badge> : <Badge dot>{t("admin.disabled")}</Badge>}
                </td>
                <td>
                  <div className="adm-cell-actions">
                    <Btn kind="ghost" size="sm" icon="settings" disabled={busy} onClick={() => setOpenId(s.id)}>{t("admin.manage")}</Btn>
                    {!s.is_root && (
                      <RowMenu items={[
                        { label: s.active ? t("admin.disable") : t("admin.enable"), icon: "power", disabled: busy, onClick: () => toggleActive(s) },
                        { label: t("admin.deleteSpace"), icon: "trash-2", danger: true, disabled: busy, onClick: () => void remove(s) },
                      ]} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
