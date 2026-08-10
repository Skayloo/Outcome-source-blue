/**
 * AdminBugsPanel — owner triage for "Send To Developer" reports. Lists every report with the
 * reporter, description and screenshots rendered INLINE, plus a status dropdown
 * (New / In Progress / Fixed). Filterable by status.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { assetUrl } from "@lib/serverHost";
import { t } from "@lib/i18n";
import { Section, Banner } from "@components/settings/controls";
import { statusLabel, Pager, BUG_PAGE_SIZE } from "@components/BugReportModal";
import type { BugReportDto, BugStatus } from "@lib/types";

function errMsg(e: unknown, f: string): string { return e instanceof Error ? e.message : f; }

const STATUSES: BugStatus[] = ["new", "in_progress", "fixed"];
type Filter = "all" | BugStatus;

export function AdminBugsPanel() {
  const [bugs, setBugs] = useState<BugReportDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const b = await api.adminListBugs(signal);
      if (!signal?.aborted) setBugs(b);
    } catch (e: unknown) {
      if (!signal?.aborted) setError(errMsg(e, t("admin.actionFailed")));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);
  useEffect(() => { setPage(1); }, [filter]); // reset to first page when the status filter changes

  const changeStatus = (id: number, status: BugStatus): void => {
    const prev = bugs;
    setBugs((bs) => bs.map((b) => (b.id === id ? { ...b, status } : b)));
    void api.adminSetBugStatus(id, status).catch((e: unknown) => {
      setBugs(prev);
      setError(errMsg(e, t("admin.bugsUpdateFailed")));
    });
  };

  const shown = filter === "all" ? bugs : bugs.filter((b) => b.status === filter);
  const count = (f: Filter): number => (f === "all" ? bugs.length : bugs.filter((b) => b.status === f).length);
  const pageCount = Math.max(1, Math.ceil(shown.length / BUG_PAGE_SIZE));
  const cur = Math.min(page, pageCount);
  const pageItems = shown.slice((cur - 1) * BUG_PAGE_SIZE, cur * BUG_PAGE_SIZE);

  return (
    <div className="settings-pane active">
      <div className="admin-toolbar">
        <Section title={t("admin.bugs")} />
        <span className="spacer" />
        <button className="ac-btn" disabled={loading} onClick={() => load()}>{loading ? t("admin.loading") : t("admin.refresh")}</button>
      </div>

      <div className="bug-filter">
        <button className={"bug-filter-tab" + (filter === "all" ? " active" : "")} onClick={() => setFilter("all")}>
          {t("admin.bugsAll")} <span className="bug-filter-count">{count("all")}</span>
        </button>
        {STATUSES.map((s) => (
          <button key={s} className={"bug-filter-tab" + (filter === s ? " active" : "")} onClick={() => setFilter(s)}>
            {statusLabel(s)} <span className="bug-filter-count">{count(s)}</span>
          </button>
        ))}
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {shown.length === 0 && !loading ? (
        <Banner kind="info">{t("admin.bugsEmpty")}</Banner>
      ) : (
        <div className="admin-bug-list">
          {pageItems.map((b) => (
            <div className="admin-bug-card" key={b.id}>
              <div className="admin-bug-head">
                <div className="admin-bug-meta">
                  <span className={`bug-status bug-status-${b.status}`}>{statusLabel(b.status)}</span>
                  <span className="admin-bug-reporter">
                    {t("admin.bugsBy")} <b>{b.reporter_name}</b> · #{b.id}
                  </span>
                  <span className="admin-bug-date">{new Date(b.created_at).toLocaleString()}</span>
                </div>
                <select
                  className="bug-status-select"
                  value={b.status}
                  onChange={(e) => changeStatus(b.id, e.target.value as BugStatus)}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
              </div>

              {b.title && <div className="admin-bug-title">{b.title}</div>}
              <div className="admin-bug-desc">{b.description}</div>

              {b.attachments.length > 0 && (
                <div className="admin-bug-shots">
                  <div className="admin-bug-shots-label">{t("admin.bugsScreenshots")} ({b.attachments.length})</div>
                  <div className="admin-bug-shots-grid">
                    {b.attachments.map((url) => (
                      <button className="admin-bug-shot" key={url} onClick={() => setLightbox(url)}>
                        <img src={assetUrl(url)} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          <Pager page={cur} pageCount={pageCount} onPage={setPage} />
        </div>
      )}

      {lightbox && (
        <div className="bug-lightbox" onClick={() => setLightbox(null)}>
          <img src={assetUrl(lightbox)} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
