/**
 * The support mailbox — what arrives at the instance's own address, and answers to it.
 *
 * A list on the left, one message on the right, a reply box under it. Not a mail client: no
 * folders, no attachments, no composing to somebody who has not written first. It exists so
 * a support request is seen and answered where the people who answer it already are, instead
 * of in a webmail nobody opens.
 *
 * Everything shown here was written by a stranger. It is rendered as TEXT — the server already
 * converted HTML-only mail — and nothing on this screen interpolates it as markup.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import type { SupportMailSummary, SupportMailMessage } from "@lib/types";

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

const PAGE = 50;

export function AdminMailPanel() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [list, setList] = useState<SupportMailSummary[]>([]);
  const [open, setOpen] = useState<SupportMailMessage | null>(null);
  const [openingUid, setOpeningUid] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    api.adminListMail(PAGE, 0, signal)
      .then((r) => { setConfigured(r.configured); setList(r.messages); setError(null); })
      .catch((e: unknown) => { if (!signal?.aborted) setError(errMsg(e, t("adminMail.loadFailed"))); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, []);

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);

  const openMessage = (uid: number): void => {
    setOpeningUid(uid);
    setOpen(null);
    setReply("");
    setSent(false);
    setError(null);
    api.adminGetMail(uid)
      .then((m) => {
        setOpen(m);
        // It is read now, on the server too — reflect that without refetching the list.
        setList((prev) => prev.map((x) => (x.uid === uid ? { ...x, seen: true } : x)));
      })
      .catch((e: unknown) => setError(errMsg(e, t("adminMail.openFailed"))))
      .finally(() => setOpeningUid(null));
  };

  const send = (): void => {
    if (open === null || reply.trim().length === 0) return;
    setSending(true);
    setError(null);
    api.adminReplyMail(open.uid, reply)
      .then(() => { setSent(true); setReply(""); })
      .catch((e: unknown) => setError(errMsg(e, t("adminMail.replyFailed"))))
      .finally(() => setSending(false));
  };

  if (configured === false) {
    return (
      <div className="setting-desc" style={{ marginTop: 16 }}>
        {t("adminMail.notConfigured")}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 320px) 1fr", gap: 16, marginTop: 12 }}>
      <div style={{ borderRight: "1px solid var(--border)", paddingRight: 12, maxHeight: "62vh", overflowY: "auto" }}>
        <button className="ac-btn" style={{ marginBottom: 10 }} disabled={loading} onClick={() => load()}>
          {loading ? t("adminMail.loading") : t("adminMail.refresh")}
        </button>
        {list.length === 0 && !loading && (
          <div className="setting-desc">{t("adminMail.empty")}</div>
        )}
        {list.map((m) => (
          <button
            key={m.uid}
            onClick={() => openMessage(m.uid)}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "9px 10px",
              marginBottom: 4, borderRadius: 8, border: "none", cursor: "pointer",
              background: open?.uid === m.uid ? "var(--surface-2, rgba(125,92,255,.14))" : "transparent",
              color: "inherit", font: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontWeight: m.seen ? 400 : 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.fromName || m.from}
              </span>
              <span className="setting-desc" style={{ flex: "0 0 auto" }}>{when(m.date)}</span>
            </div>
            <div style={{ fontWeight: m.seen ? 400 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.subject || t("adminMail.noSubject")}
            </div>
            <div className="setting-desc" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.preview}
            </div>
          </button>
        ))}
      </div>

      <div style={{ maxHeight: "62vh", overflowY: "auto" }}>
        {error !== null && <div className="error-banner visible" role="alert">{error}</div>}
        {openingUid !== null && <div className="setting-desc">{t("adminMail.loading")}</div>}
        {open === null && openingUid === null && (
          <div className="setting-desc">{t("adminMail.pickOne")}</div>
        )}
        {open !== null && (
          <>
            <h2 style={{ margin: "0 0 4px" }}>{open.subject || t("adminMail.noSubject")}</h2>
            <div className="setting-desc" style={{ marginBottom: 12 }}>
              {open.fromName ? `${open.fromName} · ` : ""}{open.from} · {new Date(open.date).toLocaleString()}
            </div>
            {open.htmlOnly && (
              <div className="setting-desc" style={{ marginBottom: 8 }}>{t("adminMail.htmlOnly")}</div>
            )}
            <pre style={{
              whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "0 0 16px",
              font: "inherit", background: "var(--surface)", padding: 12, borderRadius: 10,
            }}>{open.body}</pre>

            <div className="setting-desc" style={{ marginBottom: 6 }}>
              {t("adminMail.replyingTo", { address: open.from })}
            </div>
            <textarea
              className="form-input"
              rows={6}
              style={{ width: "100%", marginBottom: 10, resize: "vertical" }}
              placeholder={t("adminMail.replyPlaceholder")}
              value={reply}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => { setReply(e.target.value); setSent(false); }}
            />
            {sent && <div className="setting-desc" style={{ marginBottom: 8 }}>{t("adminMail.sent")}</div>}
            <button className="ac-btn" disabled={sending || reply.trim().length === 0} onClick={send}>
              {sending ? t("adminMail.sending") : t("adminMail.send")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
