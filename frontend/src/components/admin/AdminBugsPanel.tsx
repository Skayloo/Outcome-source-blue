/**
 * AdminBugsPanel — owner triage for "Send To Developer" reports. Lists every report with the
 * reporter, description and screenshots rendered INLINE, plus a status dropdown
 * (New / In Progress / Fixed). Filterable by status.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { assetUrl } from "@lib/serverHost";
import { t } from "@lib/i18n";
import { Banner } from "@components/settings/controls";
import { Avatar, Badge, Empty, IconBtn, Spacer, Toolbar, type Tone } from "@components/admin/kit";
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

  const tone = (st: BugStatus): Tone => (st === "new" ? "warning" : st === "in_progress" ? "accent" : "success");

  return (
    <div className="settings-pane active">
      <Toolbar>
        <div className="adm-segmented" role="tablist">
          <button role="tab" aria-selected={filter === "all"} className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>
            {t("admin.bugsAll")} <span>{count("all")}</span>
          </button>
          {STATUSES.map((st) => (
            <button key={st} role="tab" aria-selected={filter === st} className={filter === st ? "is-active" : ""} onClick={() => setFilter(st)}>
              {statusLabel(st)} <span>{count(st)}</span>
            </button>
          ))}
        </div>
        <Spacer />
        <IconBtn icon="refresh-cw" label={t("admin.refresh")} disabled={loading} onClick={() => void load()} />
      </Toolbar>

      {error && <Banner kind="error">{error}</Banner>}

      {shown.length === 0 && !loading ? (
        <Empty icon="bug" title={t("admin.bugsEmpty")} />
      ) : (
        <div className="adm-stack">
          {pageItems.map((b) => (
            <article className={"adm-item" + (b.status === "new" ? " is-attention" : "")} key={b.id}>
              <header className="adm-item-head">
                <Avatar name={b.reporter_name} size={32} />
                <div className="adm-item-who">
                  <div><b>{b.reporter_name}</b> <span className="adm-cell-sub">#{b.id}</span></div>
                  <div className="adm-cell-sub">{new Date(b.created_at).toLocaleString()}</div>
                </div>
                <Badge tone={tone(b.status)} dot>{statusLabel(b.status)}</Badge>
                <select
                  className="form-input adm-select-sm"
                  value={b.status}
                  aria-label={t("admin.status")}
                  onChange={(e) => changeStatus(b.id, e.target.value as BugStatus)}
                >
                  {STATUSES.map((st) => <option key={st} value={st}>{statusLabel(st)}</option>)}
                </select>
              </header>

              {b.title && <div className="adm-item-title">{b.title}</div>}
              <div className="adm-item-text">{b.description}</div>

              {b.attachments.length > 0 && (
                <div className="adm-shots">
                  {b.attachments.map((url) => (
                    <button type="button" className="adm-shot" key={url} onClick={() => setLightbox(url)} aria-label={t("admin.bugsScreenshots")}>
                      <img src={assetUrl(url)} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </article>
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
