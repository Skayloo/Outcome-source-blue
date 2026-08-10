/**
 * AdminReportsPanel — the moderation inbox: messages users reported as objectionable.
 * `content` is the server's report-time SNAPSHOT, so it still shows what was reported even
 * if the author edited or deleted the message afterwards. Filterable by status; each report
 * moves through open → resolved / dismissed.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Section, Banner } from "@components/settings/controls";
import { Pager } from "@components/BugReportModal";
import type { MessageReportDto, ReportStatus } from "@lib/types";

function errMsg(e: unknown, f: string): string { return e instanceof Error ? e.message : f; }

const STATUSES: ReportStatus[] = ["open", "resolved", "dismissed"];
const PAGE_SIZE = 20;

function statusLabel(s: ReportStatus): string {
  return s === "open" ? t("admin.reportOpen")
    : s === "resolved" ? t("admin.reportResolved")
    : t("admin.reportDismissed");
}

export function AdminReportsPanel() {
  const [reports, setReports] = useState<MessageReportDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback((signal?: AbortSignal): void => {
    setLoading(true);
    setError(null);
    void api
      .adminListReportsPaged(PAGE_SIZE, (page - 1) * PAGE_SIZE, signal)
      .then((r) => { setReports(r.items); setTotal(r.total); })
      .catch((e: unknown) => { if (!signal?.aborted) setError(errMsg(e, t("admin.actionFailed"))); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, [page]);

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);

  const setStatus = (id: number, status: ReportStatus): void => {
    const prev = reports;
    setReports((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
    void api.adminSetReportStatus(id, status).catch((e: unknown) => {
      setReports(prev);
      setError(errMsg(e, t("admin.actionFailed")));
    });
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="settings-pane active">
      <div className="admin-toolbar">
        <Section title={t("admin.reports")} />
        <span className="spacer" />
        <button className="ac-btn" disabled={loading} onClick={() => load()}>
          {loading ? t("admin.loading") : t("admin.refresh")}
        </button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {reports.length === 0 && !loading ? (
        <Banner kind="info">{t("admin.reportsEmpty")}</Banner>
      ) : (
        <div className="admin-bug-list">
          {reports.map((r) => (
            <div className="admin-bug-card" key={r.id}>
              <div className="admin-bug-head">
                <div className="admin-bug-meta">
                  <span className={`bug-status bug-status-${r.status === "open" ? "new" : r.status === "resolved" ? "fixed" : "in_progress"}`}>
                    {statusLabel(r.status)}
                  </span>
                  <span className="admin-bug-reporter">
                    {t("admin.reportedBy")} <b>{r.reporter_name}</b> · {t("admin.reportAuthor")} <b>{r.author_name}</b> · #{r.message_id}
                  </span>
                  <span className="admin-bug-date">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <select
                  className="bug-status-select"
                  value={r.status}
                  onChange={(e) => setStatus(r.id, e.target.value as ReportStatus)}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
              </div>

              {/* The snapshot — what the reporter actually saw. */}
              <div className="admin-bug-desc" style={{ whiteSpace: "pre-wrap" }}>
                {r.content.length > 0 ? r.content : <i>{t("admin.reportNoContent")}</i>}
              </div>
              {r.reason.length > 0 && (
                <div className="setting-desc" style={{ marginTop: 6 }}>
                  {t("admin.reportReason")}: {r.reason}
                </div>
              )}
            </div>
          ))}
          <Pager page={Math.min(page, pageCount)} pageCount={pageCount} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
