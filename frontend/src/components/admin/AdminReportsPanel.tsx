/**
 * AdminReportsPanel — the moderation inbox: messages users reported as objectionable.
 * `content` is the server's report-time SNAPSHOT, so it still shows what was reported even
 * if the author edited or deleted the message afterwards. Filterable by status; each report
 * moves through open → resolved / dismissed.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { confirm, prompt } from "@components/ConfirmDialog";
import { setTransientError, setTransientSuccess } from "@stores/ui.store";
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
    : s === "closed" ? t("admin.reportClosedLabel")
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

  /** Removing the message ends the report; answering the reporter only resolves it. */
  const act = (id: number, action: "hide" | "delete", title: string, body: string, label: string): void => {
    void confirm({ title, message: body, confirmLabel: label, danger: true }).then((ok) => {
      if (!ok) return;
      api.reportAction(id, action)
        .then(() => {
          setReports((rs) => rs.map((r) => (r.id === id ? { ...r, status: "closed" as ReportStatus } : r)));
          setTransientSuccess(t("admin.reportClosed"));
        })
        .catch((e: unknown) => setTransientError(e instanceof Error ? e.message : String(e)));
    });
  };

  /** "Nothing wrong with it" — the reporter is told so, and forwarded the message in question
   *  so the answer is not about a number they have to go and look up. */
  const dismissWithReply = (id: number): void => {
    void prompt({
      title: t("admin.reportReplyTitle"),
      message: t("admin.reportReplyBody"),
      confirmLabel: t("admin.reportReply"),
      input: { placeholder: t("admin.reportReplyPlaceholder"), maxLength: 500 },
    }).then((note) => {
      if (note === null) return;
      api.reportAction(id, "dismiss", note)
        .then(() => {
          setReports((rs) => rs.map((r) => (r.id === id ? { ...r, status: "resolved" as ReportStatus } : r)));
          setTransientSuccess(t("admin.reportReplied"));
        })
        .catch((e: unknown) => setTransientError(e instanceof Error ? e.message : String(e)));
    });
  };

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
                  <span className={`bug-status bug-status-${r.status === "open" ? "new" : r.status === "resolved" || r.status === "closed" ? "fixed" : "in_progress"}`}>
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
                  disabled={r.status === "closed"}
                  title={r.status === "closed" ? t("admin.reportClosedHint") : undefined}
                  onChange={(e) => setStatus(r.id, e.target.value as ReportStatus)}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
                {/* A queue you cannot act on is a list of complaints. This is the acting — and
                    once acted on, a report is done: the controls go with it. */}
                {r.status !== "closed" && (
                  <>
                    <button className="btn-sm" onClick={() => dismissWithReply(r.id)}>
                      {t("admin.reportReply")}
                    </button>
                    <button className="btn-sm" onClick={() => act(r.id, "hide",
                      t("admin.reportHideTitle"), t("admin.reportHideBody"), t("admin.reportHide"))}>
                      {t("admin.reportHide")}
                    </button>
                    <button className="btn-danger-sm" onClick={() => act(r.id, "delete",
                      t("admin.reportDeleteTitle"), t("admin.reportDeleteBody"), t("admin.reportDeleteMessage"))}>
                      {t("admin.reportDeleteMessage")}
                    </button>
                  </>
                )}
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
