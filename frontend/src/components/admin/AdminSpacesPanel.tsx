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
import { Section, Banner } from "@components/settings/controls";
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
      <div className="admin-toolbar">
        <Section title={t("admin.spaces")} />
        <span className="spacer" />
        <button className="ac-btn" disabled={busy || loading} onClick={() => load()}>{loading ? t("admin.loading") : t("admin.refresh")}</button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      <Banner kind="info">{t("admin.spacesHint")}</Banner>

      <div className="admin-toolbar">
        <input className="form-input mono" type="text" placeholder="core_otc" value={slug} disabled={busy}
               onChange={(e) => setSlug(e.target.value)} />
        <input className="form-input" type="text" placeholder={t("admin.spaceName")} value={name} disabled={busy}
               onChange={(e) => setName(e.target.value)} />
        <input className="form-input mono" type="text" placeholder="coreotc.outcome.ru" value={domain} disabled={busy}
               onChange={(e) => setDomain(e.target.value)} />
      </div>
      <div className="admin-toolbar">
        <input className="form-input" type="email" placeholder={t("admin.ownerEmail")} value={ownerEmail} disabled={busy}
               onChange={(e) => setOwnerEmail(e.target.value)} />
        <input className="form-input" type="text" placeholder={t("admin.ownerUsername")} value={ownerName} disabled={busy}
               onChange={(e) => setOwnerName(e.target.value)} />
        <input className="form-input" type="password" placeholder={t("admin.ownerPassword")} value={ownerPass} disabled={busy}
               autoComplete="new-password" onChange={(e) => setOwnerPass(e.target.value)} />
        <button className="ac-btn" disabled={busy || !slug.trim() || !name.trim()} onClick={create}>
          {busy ? t("admin.working") : t("admin.createSpace")}
        </button>
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>{t("admin.spaceSlug")}</th>
            <th>{t("admin.serverName")}</th>
            <th>{t("admin.domain")}</th>
            <th>{t("admin.users")}</th>
            <th>{t("admin.servers")}</th>
            <th>{t("admin.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {spaces.map((s) => (
            <tr key={s.id} className={s.active ? undefined : "dimmed"}>
              <td className="mono">{s.id}</td>
              <td className="mono">{s.slug}</td>
              <td>{s.name}</td>
              <td className="mono">{s.domain ?? "—"}</td>
              <td className="mono">{s.user_count}</td>
              <td className="mono">{s.server_count}</td>
              <td className="admin-actions-cell">
                <button className="ac-btn" disabled={busy} onClick={() => setOpenId(s.id)}>{t("admin.manage")}</button>
                {!s.is_root && (
                  <>
                    <button className="ac-btn" disabled={busy} onClick={() => toggleActive(s)}>
                      {s.active ? t("admin.disable") : t("admin.enable")}
                    </button>
                    <button className="ac-btn account-delete-btn" disabled={busy} onClick={() => remove(s)}>{t("admin.delete")}</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
