/**
 * AdminUsersPanel — full member management: search, Ban/Unban, Kick, hard Delete,
 * per-user ROLE change, and direct PERMISSION grants (user_claims on top of the role).
 */
import { Fragment, useCallback, useEffect, useState, type ChangeEvent } from "react";
import { confirm } from "@components/ConfirmDialog";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Section, Banner } from "@components/settings/controls";
import { Pager } from "@components/BugReportModal";
import type { AdminUserResponse, RoleResponse } from "@lib/types";

const PAGE_SIZE = 25;

function errMsg(e: unknown, f: string): string {
  return e instanceof Error ? e.message : f;
}

export function AdminUsersPanel() {
  const [users, setUsers] = useState<readonly AdminUserResponse[]>([]);
  const [roles, setRoles] = useState<RoleResponse[]>([]);
  const [allPerms, setAllPerms] = useState<string[]>([]);
  const [permsFor, setPermsFor] = useState<number | null>(null);   // user id whose perms are expanded
  const [userPerms, setUserPerms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // Debounced copy of `query`: the list refetches on THIS, so typing doesn't fire a
  // request per keystroke. Search happens server-side — the list is paginated, so a
  // client-side filter would only ever see the current page.
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const loadUsers = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [u, r] = await Promise.all([
        api.adminListUsersPaged(PAGE_SIZE, (page - 1) * PAGE_SIZE, search, signal),
        api.getRoles(signal),
      ]);
      if (signal?.aborted) return;
      setUsers(u.items);
      setTotal(u.total);
      setRoles(r);
    } catch (e: unknown) {
      if (!signal?.aborted) setError(errMsg(e, t("admin.failedLoadUsers")));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    const c = new AbortController();
    void loadUsers(c.signal);
    return () => c.abort();
  }, [loadUsers]);

  useEffect(() => {
    const c = new AbortController();
    void api.adminListPermissions(c.signal).then((p) => { if (!c.signal.aborted) setAllPerms(p); }).catch(() => { /* best effort */ });
    return () => c.abort();
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => { setSearch(query.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const runAction = (op: () => Promise<void>, reload = true): void => {
    setBusy(true);
    setError(null);
    void op()
      .then(() => (reload ? loadUsers() : undefined))
      .catch((e: unknown) => setError(errMsg(e, t("admin.actionFailed"))))
      .finally(() => setBusy(false));
  };

  const changeRole = (id: number, roleId: number): void =>
    runAction(() => api.adminChangeRole(id, roleId));

  const deleteUser = async (u: AdminUserResponse): Promise<void> => {
    if (!(await confirm({ message: t("admin.hardDeleteConfirm", { name: u.username }), danger: true, highlight: u.username }))) return;
    runAction(() => api.adminHardDeleteUser(u.id));
  };

  const togglePerms = (id: number): void => {
    if (permsFor === id) { setPermsFor(null); return; }
    setPermsFor(id);
    setUserPerms([]);
    void api.adminGetUserPermissions(id).then(setUserPerms).catch(() => setUserPerms([]));
  };

  const togglePerm = (id: number, perm: string, has: boolean): void => {
    setBusy(true);
    const call = has ? api.adminRevokePermission(id, perm) : api.adminGrantPermission(id, perm);
    void call
      .then(() => setUserPerms((prev) => (has ? prev.filter((p) => p !== perm) : [...prev, perm])))
      .catch((e: unknown) => setError(errMsg(e, t("admin.actionFailed"))))
      .finally(() => setBusy(false));
  };

  const visible = users;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const roleName = (id: number): string => roles.find((r) => r.id === id)?.name ?? String(id);

  return (
    <div className="settings-pane active">
      <div className="admin-toolbar">
        <Section title={t("admin.users")} />
        <input className="form-input" type="text" placeholder={t("admin.searchUsers")} value={query} onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} />
        <span className="spacer" />
        <button className="ac-btn" disabled={busy || loading} onClick={() => loadUsers()}>{loading ? t("admin.loading") : t("admin.refresh")}</button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {users.length === 0 && !loading ? (
        <Banner kind="info">{t("admin.noUsers")}</Banner>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("admin.username")}</th>
              <th>{t("admin.role")}</th>
              <th>{t("admin.status")}</th>
              <th>{t("admin.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => {
              const expanded = permsFor === u.id;
              return (
              <Fragment key={u.id}>
                <tr>
                  <td>
                    {u.username}
                    {u.banned && <span className="admin-badge danger" style={{ marginLeft: 8 }}>{t("admin.banned")}</span>}
                  </td>
                  <td>
                    <select
                      className="form-input admin-role-select"
                      value={u.role_id}
                      disabled={busy}
                      onChange={(e) => changeRole(u.id, Number(e.target.value))}
                    >
                      {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      {!roles.some((r) => r.id === u.role_id) && <option value={u.role_id}>{roleName(u.role_id)}</option>}
                    </select>
                  </td>
                  <td>{u.status}</td>
                  <td className="admin-actions-cell">
                    {u.banned
                      ? <button className="ac-btn" disabled={busy} onClick={() => runAction(() => api.adminUnbanMember(u.id))}>{t("admin.unban")}</button>
                      : <button className="ac-btn" disabled={busy} onClick={() => runAction(() => api.adminBanMember(u.id, ""))}>{t("admin.ban")}</button>}
                    <button className="ac-btn" disabled={busy} onClick={() => runAction(() => api.adminKickMember(u.id), false)}>{t("admin.kick")}</button>
                    <button className={"ac-btn" + (expanded ? " on" : "")} disabled={busy} onClick={() => togglePerms(u.id)}>{t("admin.permissions")}</button>
                    <button className="ac-btn account-delete-btn" disabled={busy} onClick={() => deleteUser(u)}>{t("admin.delete")}</button>
                  </td>
                </tr>
                {expanded && (
                  <tr className="admin-perms-row">
                    <td colSpan={4}>
                      <div className="admin-perms-title">{t("admin.directPermissions")} — {u.username}</div>
                      <div className="admin-perms-grid">
                        {allPerms.map((p) => {
                          const has = userPerms.includes(p);
                          return (
                            <label key={p} className={"admin-perm-chip" + (has ? " on" : "")}>
                              <input type="checkbox" checked={has} disabled={busy} onChange={() => togglePerm(u.id, p, has)} />
                              {p}
                            </label>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <Pager page={Math.min(page, pageCount)} pageCount={pageCount} onPage={setPage} />
    </div>
  );
}
