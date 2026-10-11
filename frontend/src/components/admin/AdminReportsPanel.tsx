/**
 * AdminReportsPanel — the moderation inbox: messages users reported as objectionable.
 * `content` is the server's report-time SNAPSHOT, so it still shows what was reported even
 * if the author edited or deleted the message afterwards. Filterable by status; each report
 * moves through open → resolved / dismissed.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { authStore } from "@stores/auth.store";
import { confirm, prompt } from "@components/ConfirmDialog";
import { setTransientError, setTransientSuccess } from "@stores/ui.store";
import { t } from "@lib/i18n";
import { Banner } from "@components/settings/controls";
import { Avatar, Badge, Btn, Empty, IconBtn, RowMenu, Spacer, Toolbar, type Tone } from "@components/admin/kit";
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

/**
 * @param scope Whose queue this is. `instance` is every complaint on the deployment, for
 *   whoever runs it. `server` is only the ones about the ACTIVE server's own channels — what
 *   its moderators may see, and never a direct message, which belongs to no server.
 */
export function AdminReportsPanel({ scope = "instance" }: { scope?: "instance" | "server" } = {}) {
  const meId = authStore.getState().user?.id ?? 0;
  const [reports, setReports] = useState<MessageReportDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback((signal?: AbortSignal): void => {
    setLoading(true);
    setError(null);
    const list = scope === "server" ? api.listServerReportsPaged : api.adminListReportsPaged;
    void list(PAGE_SIZE, (page - 1) * PAGE_SIZE, signal)
      .then((r) => { setReports(r.items); setTotal(r.total); })
      .catch((e: unknown) => { if (!signal?.aborted) setError(errMsg(e, t("admin.actionFailed"))); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, [page, scope]);

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
  /** Answering is for the OTHER person. On your own report there is nobody to write to, so the
   *  button says what it will actually do rather than promising a message that goes nowhere. */
  const dismissWithReply = (id: number, ownReport: boolean): void => {
    if (ownReport) {
      void confirm({
        title: t("admin.reportOwnTitle"),
        message: t("admin.reportOwnBody"),
        confirmLabel: t("admin.reportResolveOnly"),
      }).then((ok) => {
        if (!ok) return;
        api.reportAction(id, "dismiss")
          .then(() => {
            setReports((rs) => rs.map((r) => (r.id === id ? { ...r, status: "resolved" as ReportStatus } : r)));
            setTransientSuccess(t("admin.reportResolvedToast"));
          })
          .catch((e: unknown) => setTransientError(e instanceof Error ? e.message : String(e)));
      });
      return;
    }

    void prompt({
      title: t("admin.reportReplyTitle"),
      message: t("admin.reportReplyBody"),
      confirmLabel: t("admin.reportReply"),
      // Filled in, not hinted: the same answer fits nine reports out of ten, and a hint you
      // have to retype is how people stop sending one at all. Edit it or send as is.
      input: {
        placeholder: t("admin.reportReplyPlaceholder"),
        defaultValue: t("admin.reportReplyDefault"),
        maxLength: 500,
      },
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

  const tone = (st: ReportStatus): Tone =>
    st === "open" ? "warning" : st === "resolved" ? "success" : st === "closed" ? "neutral" : "accent";

  return (
    <div className="settings-pane active">
      <Toolbar>
        <span className="adm-count">{t("admin.reportsTotal", { count: total })}</span>
        <Spacer />
        <IconBtn icon="refresh-cw" label={t("admin.refresh")} disabled={loading} onClick={() => void load()} />
      </Toolbar>

      {error && <Banner kind="error">{error}</Banner>}

      {reports.length === 0 && !loading ? (
        <Empty icon="flag" title={t("admin.reportsEmpty")} text={t("admin.reportsEmptyText")} />
      ) : (
        <div className="adm-stack">
          {reports.map((r) => (
            <article className={"adm-item" + (r.status === "open" ? " is-attention" : "")} key={r.id}>
              <header className="adm-item-head">
                <Avatar name={r.author_name} size={32} />
                <div className="adm-item-who">
                  <div><b>{r.author_name}</b> <span className="adm-cell-sub">#{r.message_id}</span></div>
                  <div className="adm-cell-sub">
                    {t("admin.reportedBy")} {r.reporter_name} · {new Date(r.created_at).toLocaleString()}
                  </div>
                </div>
                <Badge tone={tone(r.status)} dot>{statusLabel(r.status)}</Badge>
              </header>

              {/* The snapshot — what the reporter actually saw. */}
              <blockquote className="adm-quote">
                {r.content.length > 0 ? r.content : <i>{t("admin.reportNoContent")}</i>}
              </blockquote>
              {r.reason.length > 0 && (
                <div className="adm-cell-sub">{t("admin.reportReason")}: {r.reason}</div>
              )}

              {/* A queue you cannot act on is a list of complaints. This is the acting — and
                  once acted on, a report is done: the controls go with it. */}
              {r.status !== "closed" && (
                <footer className="adm-item-actions">
                  <Btn kind="secondary" size="sm" icon="reply" onClick={() => dismissWithReply(r.id, r.reporter_id === meId)}>
                    {t("admin.reportReply")}
                  </Btn>
                  <Btn kind="ghost" size="sm" icon="eye-off" onClick={() => act(r.id, "hide",
                    t("admin.reportHideTitle"), t("admin.reportHideBody"), t("admin.reportHide"))}>
                    {t("admin.reportHide")}
                  </Btn>
                  <Spacer />
                  <select
                    className="form-input adm-select-sm"
                    value={r.status}
                    aria-label={t("admin.status")}
                    onChange={(e) => setStatus(r.id, e.target.value as ReportStatus)}
                  >
                    {STATUSES.map((st) => <option key={st} value={st}>{statusLabel(st)}</option>)}
                  </select>
                  <RowMenu items={[
                    { label: t("admin.reportDeleteMessage"), icon: "trash-2", danger: true, onClick: () => act(r.id, "delete",
                      t("admin.reportDeleteTitle"), t("admin.reportDeleteBody"), t("admin.reportDeleteMessage")) },
                  ]} />
                </footer>
              )}
            </article>
          ))}
          <Pager page={Math.min(page, pageCount)} pageCount={pageCount} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
