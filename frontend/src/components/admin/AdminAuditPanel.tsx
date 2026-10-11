/**
 * AdminAuditPanel — paginated view of the server audit log. Loads pages of 50
 * entries from the REST api (GET /api/v1/admin/audit); the first page replaces
 * the list, subsequent "Load more" pages append. A text Refresh button reloads
 * from offset 0.
 */
import { useEffect, useState } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Banner } from "@components/settings/controls";
import { Avatar, Badge, Btn, Empty, IconBtn, Spacer, Toolbar } from "@components/admin/kit";
import { type AuditEntryResponse } from "@lib/types";

const PAGE_SIZE = 50;

function errMsg(e: unknown, f: string): string {
  return e instanceof Error ? e.message : f;
}

export function AdminAuditPanel() {
  const [entries, setEntries] = useState<readonly AuditEntryResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const load = (off: number, signal?: AbortSignal): void => {
    setLoading(true);
    setError(null);
    void api
      .getAuditLog(PAGE_SIZE, off, signal)
      .then((page) => {
        if (signal?.aborted) return;
        setEntries((prev) => (off === 0 ? page : [...prev, ...page]));
        setHasMore(page.length === PAGE_SIZE);
        setOffset(off + page.length);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setError(errMsg(e, t("admin.failedLoadAudit")));
        setLoading(false);
      });
  };

  // Initial fetch on mount (page 0).
  useEffect(() => {
    const controller = new AbortController();
    load(0, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="settings-pane active">
      <Toolbar>
        <Spacer />
        <IconBtn icon="refresh-cw" label={t("admin.refresh")} disabled={loading} onClick={() => load(0)} />
      </Toolbar>

      {error && <Banner kind="error">{error}</Banner>}

      {entries.length === 0 && !loading && !error ? (
        <Empty icon="file-text" title={t("admin.noAudit")} />
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("admin.time")}</th>
              <th>{t("admin.actor")}</th>
              <th>{t("admin.action")}</th>
              <th>{t("admin.target")}</th>
              <th>{t("admin.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="adm-cell-sub adm-nowrap">{new Date(entry.created_at).toLocaleString()}</td>
                <td>
                  <div className="adm-cell-user"><Avatar name={entry.actor_name} size={24} /><span>{entry.actor_name}</span></div>
                </td>
                <td><Badge tone="accent">{entry.action}</Badge></td>
                <td className="adm-cell-sub">{entry.target_type} #{entry.target_id}</td>
                <td>{entry.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {hasMore && (
        <div className="adm-more">
          <Btn kind="secondary" disabled={loading} onClick={() => load(offset)}>
            {loading ? t("admin.loading") : t("admin.loadMore")}
          </Btn>
        </div>
      )}
    </div>
  );
}
