/**
 * AdminServersPanel — instance-admin view of EVERY server: force-delete any server, or
 * expand one to manage the channels inside it — create AND force-delete — across all
 * tenants. (This replaced the old Channels tab, which could only see the active server.)
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { confirm } from "@components/ConfirmDialog";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Banner } from "@components/settings/controls";
import { Avatar, Btn, Empty, IconBtn, RowMenu, Spacer, Toolbar } from "@components/admin/kit";
import { Icon } from "@lib/icons";
import { Pager } from "@components/BugReportModal";
import type { ChannelType } from "@lib/types";

function errMsg(e: unknown, f: string): string { return e instanceof Error ? e.message : f; }

const PAGE_SIZE = 25;

interface Srv {
  id: number; name: string; owner_id: number; icon: string | null;
  /** Who to write to when a complaint about this server lands. Null if the owner is gone. */
  owner_username: string | null; owner_email: string | null;
}
interface Chan { id: number; name: string; type: string; category: string | null; server_id: number | null }

export function AdminServersPanel() {
  const [servers, setServers] = useState<Srv[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [channels, setChannels] = useState<Chan[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ChannelType>("text");

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.adminListAllServersPaged(PAGE_SIZE, (page - 1) * PAGE_SIZE, signal);
      if (!signal?.aborted) { setServers(s.items); setTotal(s.total); }
    } catch (e: unknown) {
      if (!signal?.aborted) setError(errMsg(e, t("admin.actionFailed")));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [page]);

  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);

  const openChannels = (id: number): void => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    setChannels([]);
    setNewName("");
    void api.adminListServerChannels(id).then(setChannels).catch(() => setChannels([]));
  };

  const createChannel = (serverId: number): void => {
    const name = newName.trim();
    if (name.length === 0) return;
    setBusy(true);
    setError(null);
    void api.adminCreateChannel({ name, type: newType, category: "" }, undefined, serverId)
      .then(() => { setNewName(""); return api.adminListServerChannels(serverId).then(setChannels); })
      .catch((e: unknown) => setError(errMsg(e, t("admin.actionFailed"))))
      .finally(() => setBusy(false));
  };

  const deleteServer = async (s: Srv): Promise<void> => {
    if (!(await confirm({ message: t("admin.deleteServerConfirm", { name: s.name }), danger: true, highlight: s.name }))) return;
    setBusy(true);
    void api.adminDeleteServer(s.id)
      .then(() => load())
      .catch((e: unknown) => setError(errMsg(e, t("admin.actionFailed"))))
      .finally(() => setBusy(false));
  };

  const deleteChannel = async (c: Chan): Promise<void> => {
    if (!(await confirm({ message: t("admin.deleteChannelConfirm", { name: c.name }), danger: true, highlight: c.name }))) return;
    setBusy(true);
    void api.adminForceDeleteChannel(c.id)
      .then(() => setChannels((prev) => prev.filter((x) => x.id !== c.id)))
      .catch((e: unknown) => setError(errMsg(e, t("admin.actionFailed"))))
      .finally(() => setBusy(false));
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="settings-pane active">
      <Toolbar>
        <span className="adm-count">{t("admin.serversTotal", { count: total })}</span>
        <Spacer />
        <IconBtn icon="refresh-cw" label={t("admin.refresh")} disabled={busy || loading} onClick={() => void load()} />
      </Toolbar>

      {error && <Banner kind="error">{error}</Banner>}

      {servers.length === 0 && !loading ? (
        <Empty icon="server" title={t("admin.noServers")} />
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("admin.serverName")}</th>
              <th>{t("admin.owner")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <td>
                    <div className="adm-cell-user">
                      <Avatar name={s.name} />
                      <div>
                        <div className="adm-cell-main">{s.name}</div>
                        <div className="adm-cell-sub">ID {s.id}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {s.owner_username
                      ? <><div>{s.owner_username}</div>{s.owner_email && <div className="adm-cell-sub">{s.owner_email}</div>}</>
                      : <span className="adm-cell-sub">{t("admin.ownerGone")}</span>}
                  </td>
                  <td>
                    <div className="adm-cell-actions">
                      <Btn kind={openId === s.id ? "secondary" : "ghost"} size="sm" icon="hash" disabled={busy} onClick={() => openChannels(s.id)}>
                        {t("admin.channels")}
                      </Btn>
                      <RowMenu items={[
                        { label: t("admin.deleteServer"), icon: "trash-2", danger: true, disabled: busy, onClick: () => void deleteServer(s) },
                      ]} />
                    </div>
                  </td>
                </tr>
                {openId === s.id && (
                  <tr className="adm-subrow">
                    <td colSpan={3}>
                      <div className="adm-subpanel">
                        <div className="adm-subpanel-title">{t("admin.channelsOf", { name: s.name })}</div>
                        <form className="adm-inline-form" onSubmit={(e) => { e.preventDefault(); createChannel(s.id); }}>
                          <input
                            className="form-input"
                            type="text"
                            placeholder={t("admin.channelName")}
                            value={newName}
                            disabled={busy}
                            onChange={(e) => setNewName(e.target.value)}
                          />
                          <select className="form-input" value={newType} disabled={busy} onChange={(e) => setNewType(e.target.value as ChannelType)}>
                            <option value="text">{t("admin.text")}</option>
                            <option value="voice">{t("admin.voice")}</option>
                          </select>
                          <Btn type="submit" kind="secondary" size="sm" icon="plus" disabled={busy || newName.trim().length === 0}>
                            {busy ? t("admin.working") : t("admin.createChannel")}
                          </Btn>
                        </form>
                        {channels.length === 0 ? (
                          <div className="adm-cell-sub">{t("admin.noChannels")}</div>
                        ) : (
                          <ul className="adm-chanlist">
                            {channels.map((c) => (
                              <li key={c.id}>
                                <Icon name={c.type === "voice" ? "volume-2" : "hash"} size={15} />
                                <span className="adm-chan-name">{c.name}</span>
                                {c.category && <span className="adm-cell-sub">{c.category}</span>}
                                <Spacer />
                                <IconBtn icon="trash-2" label={t("admin.deleteChannel")} disabled={busy} onClick={() => void deleteChannel(c)} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <Pager page={Math.min(page, pageCount)} pageCount={pageCount} onPage={setPage} />
    </div>
  );
}
