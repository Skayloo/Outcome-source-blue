/**
 * AdminServersPanel — instance-admin view of EVERY server: force-delete any server, or
 * expand one to manage the channels inside it — create AND force-delete — across all
 * tenants. (This replaced the old Channels tab, which could only see the active server.)
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { confirm } from "@components/ConfirmDialog";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Section, Banner } from "@components/settings/controls";
import { Pager } from "@components/BugReportModal";
import type { ChannelType } from "@lib/types";

function errMsg(e: unknown, f: string): string { return e instanceof Error ? e.message : f; }

const PAGE_SIZE = 25;

interface Srv { id: number; name: string; owner_id: number; icon: string | null }
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

  return (
    <div className="settings-pane active">
      <div className="admin-toolbar">
        <Section title={t("admin.servers")} />
        <span className="spacer" />
        <button className="ac-btn" disabled={busy || loading} onClick={() => load()}>{loading ? t("admin.loading") : t("admin.refresh")}</button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {servers.length === 0 && !loading ? (
        <Banner kind="info">{t("admin.noServers")}</Banner>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>{t("admin.serverName")}</th>
              <th>{t("admin.ownerId")}</th>
              <th>{t("admin.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <td className="mono">{s.id}</td>
                  <td>{s.name}</td>
                  <td className="mono">{s.owner_id}</td>
                  <td className="admin-actions-cell">
                    <button className={"ac-btn" + (openId === s.id ? " on" : "")} disabled={busy} onClick={() => openChannels(s.id)}>{t("admin.channels")}</button>
                    <button className="ac-btn account-delete-btn" disabled={busy} onClick={() => deleteServer(s)}>{t("admin.delete")}</button>
                  </td>
                </tr>
                {openId === s.id && (
                  <tr className="admin-perms-row">
                    <td colSpan={4}>
                      <div className="admin-perms-title">{t("admin.channels")} — {s.name}</div>
                      <div className="admin-toolbar">
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
                        <button className="ac-btn" disabled={busy || newName.trim().length === 0} onClick={() => createChannel(s.id)}>
                          {busy ? t("admin.working") : t("admin.createChannel")}
                        </button>
                      </div>
                      {channels.length === 0 ? (
                        <div className="dm-empty">{t("admin.noChannels")}</div>
                      ) : (
                        <div className="admin-subchannels">
                          {channels.map((c) => (
                            <div className="admin-subchannel" key={c.id}>
                              <span className="asc-name">{c.type === "voice" ? "🔊" : "#"} {c.name}</span>
                              <span className="asc-cat">{c.category ?? ""}</span>
                              <button className="ac-btn account-delete-btn" disabled={busy} onClick={() => deleteChannel(c)}>{t("admin.delete")}</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <Pager page={Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE)))} pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
    </div>
  );
}
