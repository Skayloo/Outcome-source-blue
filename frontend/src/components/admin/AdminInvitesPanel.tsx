/**
 * AdminInvitesPanel — /admin → Invites: the codes of EVERY server in the space, each naming the
 * server it lets people into and who made it, and a form that makes one for any server.
 *
 * The per-server InviteManager (server settings, the invite window) works on the active server,
 * and the server honours X-Server-Id only for a member — so here it showed one unnamed server's
 * codes, and the space's administrator could not invite anyone into a server they were not in.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { confirm } from "@components/ConfirmDialog";
import { Banner } from "@components/settings/controls";
import { Badge, Btn, Card, Empty, IconBtn, Spinner } from "@components/admin/kit";
import { formatUses, parseLimit } from "@components/admin/InviteManager";
import { Pager } from "@components/BugReportModal";
import { getLocale, t } from "@lib/i18n";
import { api } from "@lib/services";
import { copyText } from "@lib/clipboard";
import type { AdminInvite } from "@lib/types";

const PAGE_SIZE = 25;

interface ServerOption { readonly id: number; readonly name: string }

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function dateText(iso: string, withTime = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(getLocale() === "ru" ? "ru-RU" : "en-GB", withTime
    ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", year: "numeric" });
}

export function AdminInvitesPanel() {
  const [servers, setServers] = useState<readonly ServerOption[]>([]);
  const [filter, setFilter] = useState(0);           // 0 = every server
  const [invites, setInvites] = useState<readonly AdminInvite[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [serverId, setServerId] = useState(0);       // 0 = not chosen yet: no default to get wrong
  const [maxUses, setMaxUses] = useState("");
  const [expiresHours, setExpiresHours] = useState("");
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    api.adminListAllServers(c.signal)
      .then((list) => { if (!c.signal.aborted) setServers(list.map((s) => ({ id: s.id, name: s.name }))); })
      .catch((e: unknown) => { if (!c.signal.aborted) setError(errMsg(e, t("admin.failedLoadInvites"))); });
    return () => c.abort();
  }, []);

  // Two servers may share a name (there are two "ss" on production): the id tells them apart.
  const label = useMemo(() => {
    const count = new Map<string, number>();
    for (const s of servers) count.set(s.name, (count.get(s.name) ?? 0) + 1);
    return (id: number, name: string): string => ((count.get(name) ?? 0) > 1 ? `${name} · #${id}` : name);
  }, [servers]);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    try {
      const r = await api.adminListInvites(filter || null, PAGE_SIZE, (page - 1) * PAGE_SIZE, signal);
      if (signal?.aborted) return;
      setInvites(r.items);
      setTotal(r.total);
      setError(null);
    } catch (e: unknown) {
      if (!signal?.aborted) setError(errMsg(e, t("admin.failedLoadInvites")));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  useEffect(() => {
    if (copied === null) return;
    const id = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  const pickFilter = (id: number): void => {
    setFilter(id);
    setPage(1);
    if (id) setServerId(id);   // looking at one server's codes, a new one is most likely for it
  };

  const create = (): void => {
    setError(null);
    setSuccess(null);
    if (!serverId) { setError(t("admin.inviteServerRequired")); return; }
    const data: { server_id: number; max_uses?: number; expires_in_hours?: number } = { server_id: serverId };
    const mu = parseLimit(maxUses);
    if (mu !== undefined) data.max_uses = mu;
    const eh = parseLimit(expiresHours);
    if (eh !== undefined) data.expires_in_hours = eh;
    setCreating(true);
    void api.adminCreateInvite(data)
      .then((invite) => {
        setMaxUses("");
        setExpiresHours("");
        const name = servers.find((s) => s.id === serverId)?.name ?? `#${serverId}`;
        setSuccess(t("admin.inviteCreatedFor", { code: invite.code, server: name }));
        // The new code sorts first — make sure the list in front of the reader can show it.
        if (filter && filter !== serverId) setFilter(0);
        if (page !== 1) setPage(1); else void load();
      })
      .catch((e: unknown) => setError(errMsg(e, t("admin.failedCreateInvite"))))
      .finally(() => setCreating(false));
  };

  const copy = (code: string): void => {
    void copyText(code).then((ok) => {
      if (ok) { setCopied(code); setError(null); } else setError(t("admin.failedCopyClipboard"));
    });
  };

  const revoke = async (invite: AdminInvite): Promise<void> => {
    const server = label(invite.server_id, invite.server_name);
    if (!(await confirm({ message: t("admin.revokeInviteConfirm", { code: invite.code, server }), danger: true, highlight: invite.code }))) return;
    setError(null);
    setSuccess(null);
    setRevoking(invite.code);
    void api.adminRevokeInvite(invite.code)
      .then(() => { setSuccess(t("admin.inviteRevoked", { code: invite.code })); void load(); })
      .catch((e: unknown) => setError(errMsg(e, t("admin.failedRevokeInvite"))))
      .finally(() => setRevoking(null));
  };

  const now = Date.now();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="settings-pane active">
      <Card title={t("admin.createInvite")} desc={t("admin.invitesSpaceDesc")}>
        <form className="adm-form-grid adm-form-grid--4" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <label className="adm-field">
            <span>{t("admin.inviteServer")}</span>
            <select className="form-input adm-invite-server" value={serverId} onChange={(e) => setServerId(Number(e.target.value))}>
              <option value={0} disabled>{t("admin.inviteServerPick")}</option>
              {servers.map((s) => <option key={s.id} value={s.id}>{label(s.id, s.name)}</option>)}
            </select>
            <small>{t("admin.inviteServerDesc")}</small>
          </label>
          <label className="adm-field">
            <span>{t("admin.maxUses")}</span>
            <input className="form-input" type="number" min={0} placeholder={t("admin.unlimited")}
              value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            <small>{t("admin.maxUsesDesc")}</small>
          </label>
          <label className="adm-field">
            <span>{t("admin.expiresInHours")}</span>
            <input className="form-input" type="number" min={0} placeholder={t("admin.never")}
              value={expiresHours} onChange={(e) => setExpiresHours(e.target.value)} />
            <small>{t("admin.expiresInHoursDesc")}</small>
          </label>
          <div className="adm-field adm-field--end">
            <Btn type="submit" kind="primary" icon="plus" disabled={creating || !serverId}>
              {creating ? t("admin.creating") : t("admin.createInvite")}
            </Btn>
          </div>
        </form>
        {error && <Banner kind="error">{error}</Banner>}
        {success && <Banner kind="success">{success}</Banner>}
      </Card>

      <Card title={t("admin.activeInvites")} flush actions={
        <select className="form-input adm-invite-filter" aria-label={t("admin.invitesFilter")}
          value={filter} onChange={(e) => pickFilter(Number(e.target.value))}>
          <option value={0}>{t("admin.allServers")}</option>
          {servers.map((s) => <option key={s.id} value={s.id}>{label(s.id, s.name)}</option>)}
        </select>
      }>
        {loading ? (
          <div className="adm-loading"><Spinner size={20} /></div>
        ) : invites.length === 0 ? (
          <Empty icon="user-plus" title={t("admin.noActiveInvites")} />
        ) : (
          <ul className="adm-rows">
            {invites.map((invite) => {
              // Not revoked, so listed — but a code past its date or its uses lets nobody in.
              const expired = invite.expires_at !== null && Date.parse(invite.expires_at) <= now;
              const usedUp = invite.max_uses !== null && invite.use_count >= invite.max_uses;
              const busy = revoking === invite.code;
              return (
                <li key={invite.id} className="adm-rows-item adm-invite-row">
                  <div className="adm-rows-main">
                    <div className="adm-invite-head">
                      <code className="adm-code">{invite.code}</code>
                      <Badge tone="accent">{label(invite.server_id, invite.server_name)}</Badge>
                      {expired && <Badge tone="warning">{t("admin.inviteExpired")}</Badge>}
                      {usedUp && <Badge tone="warning">{t("admin.inviteUsedUp")}</Badge>}
                    </div>
                    <div className="adm-cell-sub">
                      {t("admin.usesLabel")} {formatUses(invite)} · {t("admin.expiresLabel")}{" "}
                      {invite.expires_at ? dateText(invite.expires_at, true) : t("admin.never")} ·{" "}
                      {t("admin.inviteMadeBy", { name: invite.created_by_name || `#${invite.created_by}`, date: dateText(invite.created_at) })}
                    </div>
                  </div>
                  <Btn kind="ghost" size="sm" icon={copied === invite.code ? "check" : "copy"} onClick={() => copy(invite.code)}>
                    {copied === invite.code ? t("admin.copied") : t("admin.copy")}
                  </Btn>
                  <IconBtn icon="trash-2" label={busy ? t("admin.revoking") : t("admin.revoke")} disabled={busy} onClick={() => void revoke(invite)} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Pager page={Math.min(page, pageCount)} pageCount={pageCount} onPage={setPage} />
    </div>
  );
}
