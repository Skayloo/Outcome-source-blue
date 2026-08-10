/**
 * "Send To Developer" — a user files bug reports and tracks their status. Two views:
 *  - list: the user's own reports with status badges + a "Report Bug" button
 *  - new:  a form (optional title, description, screenshot attachments) that POSTs a report
 * Screenshots ride the normal upload pipeline (api.uploadFile → /api/v1/files/{id}); the
 * returned URLs are stored on the report and rendered inline here and in the admin panel.
 */
import { useEffect, useRef, useState } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { api } from "@lib/services";
import { assetUrl } from "@lib/serverHost";
import { MAX_UPLOAD_BYTES } from "@lib/api";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import type { BugReportDto, BugStatus } from "@lib/types";

export const BUG_PAGE_SIZE = 10;

export function statusLabel(s: BugStatus): string {
  return s === "fixed" ? t("bug.statusFixed")
    : s === "in_progress" ? t("bug.statusInProgress")
    : t("bug.statusNew");
}

/** Prev / "Page n / total" / Next. Renders nothing for a single page. */
export function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <div className="bug-pager">
      <button className="bug-pager-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t("bug.prevPage")}</button>
      <span className="bug-pager-info">{t("bug.pageOf", { n: page, total: pageCount })}</span>
      <button className="bug-pager-btn" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>{t("bug.nextPage")}</button>
    </div>
  );
}

export function BugReportModal({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<"list" | "new">("list");
  const [bugs, setBugs] = useState<BugReportDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = (signal?: AbortSignal): void => {
    setLoading(true);
    api.getMyBugs(signal)
      .then((b) => { if (!signal?.aborted) { setBugs(b); setLoading(false); } })
      .catch(() => { if (!signal?.aborted) { setError(t("bug.loadFailed")); setLoading(false); } });
  };

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, []);

  return (
    <ModalPortal>
      <div className="settings-overlay open" onClick={onClose}>
        <div className="bug-modal" onClick={(e) => e.stopPropagation()}>
          <div className="bug-header">
            <div className="bug-header-text">
              {view === "new" && (
                <button className="bug-back" onClick={() => setView("list")} title={t("bug.back")}>
                  <Icon name="chevron-right" size={18} />
                </button>
              )}
              <div>
                <h2><Icon name="bug" size={18} /> {view === "new" ? t("bug.newTitle") : t("bug.title")}</h2>
                <p>{t("bug.subtitle")}</p>
              </div>
            </div>
            <div className="bug-header-actions">
              {view === "list" && (
                <button className="btn-primary bug-new-btn" onClick={() => setView("new")}>
                  <Icon name="plus" size={16} /> {t("bug.reportBtn")}
                </button>
              )}
              <button className="settings-close-btn" onClick={onClose}><Icon name="x" size={18} /></button>
            </div>
          </div>

          {error && <div className="banner error">{error}</div>}

          {view === "new"
            ? <BugForm onDone={() => { setView("list"); load(); }} />
            : <BugList bugs={bugs} loading={loading} onReport={() => setView("new")} />}
        </div>
      </div>
    </ModalPortal>
  );
}

function BugList({ bugs, loading, onReport }: { bugs: BugReportDto[]; loading: boolean; onReport: () => void }) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(bugs.length / BUG_PAGE_SIZE));
  const cur = Math.min(page, pageCount);
  const slice = bugs.slice((cur - 1) * BUG_PAGE_SIZE, cur * BUG_PAGE_SIZE);

  if (loading) return <div className="dm-empty">{t("admin.loading")}</div>;
  if (bugs.length === 0) {
    return (
      <div className="bug-empty">
        <Icon name="bug" size={32} />
        <p>{t("bug.empty")}</p>
        <button className="btn-primary" style={{ width: "auto" }} onClick={onReport}>
          <Icon name="plus" size={16} /> {t("bug.reportBtn")}
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="bug-list">
        {slice.map((b) => <BugCard key={b.id} bug={b} />)}
      </div>
      <Pager page={cur} pageCount={pageCount} onPage={setPage} />
    </>
  );
}

function BugCard({ bug }: { bug: BugReportDto }) {
  return (
    <div className="bug-card">
      <div className="bug-card-top">
        {bug.title && <div className="bug-card-title">{bug.title}</div>}
        <span className={`bug-status bug-status-${bug.status}`}>{statusLabel(bug.status)}</span>
      </div>
      <div className="bug-card-desc">{bug.description}</div>
      {bug.attachments.length > 0 && (
        <div className="bug-shots">
          {bug.attachments.map((url) => (
            <a key={url} href={assetUrl(url)} target="_blank" rel="noreferrer" className="bug-shot">
              <img src={assetUrl(url)} alt="" loading="lazy" />
            </a>
          ))}
        </div>
      )}
      <div className="bug-card-date">{new Date(bug.created_at).toLocaleString()}</div>
    </div>
  );
}

function BugForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) { setError(t("bug.tooLarge")); return; }
    setUploading(true);
    setError(null);
    try {
      for (const f of files) {
        if (attachments.length >= 8) break;
        const res = await api.uploadFile(f);
        setAttachments((prev) => (prev.length >= 8 ? prev : [...prev, res.url]));
      }
    } catch {
      setError(t("bug.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    if (description.trim().length === 0) { setError(t("bug.descRequired")); return; }
    setSubmitting(true);
    setError(null);
    try {
      await api.createBug(description.trim(), title.trim(), attachments);
      onDone();
    } catch {
      setError(t("bug.submitFailed"));
      setSubmitting(false);
    }
  }

  return (
    <div className="bug-form">
      {error && <div className="banner error">{error}</div>}
      <div className="form-group">
        <label className="form-label">{t("bug.titleField")}</label>
        <input
          className="form-input"
          placeholder={t("bug.titlePlaceholder")}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label className="form-label">{t("bug.description")}</label>
        <textarea
          className="form-input bug-textarea"
          placeholder={t("bug.descriptionPlaceholder")}
          value={description}
          maxLength={4000}
          rows={6}
          autoFocus
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label className="form-label">{t("bug.attach")}</label>
        <div className="bug-attach-grid">
          {attachments.map((url) => (
            <div className="bug-attach-item" key={url}>
              <img src={assetUrl(url)} alt="" />
              <button
                className="bug-attach-remove"
                title={t("bug.remove")}
                onClick={() => setAttachments((prev) => prev.filter((u) => u !== url))}
              ><Icon name="x" size={13} /></button>
            </div>
          ))}
          {attachments.length < 8 && (
            <button className="bug-attach-add" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <Icon name="loader" size={18} /> : <Icon name="image" size={18} />}
              <span>{uploading ? t("bug.uploading") : t("bug.attachHint")}</span>
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={onPick}
          />
        </div>
      </div>
      <div className="bug-form-actions">
        <button className="btn-primary" disabled={submitting || uploading} onClick={submit} style={{ width: "auto" }}>
          <Icon name="send" size={15} /> {submitting ? t("bug.submitting") : t("bug.submit")}
        </button>
      </div>
    </div>
  );
}
