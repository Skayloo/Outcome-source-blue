/**
 * InviteManager — admin pane for creating, listing, and revoking server invites.
 * Renders inside an existing admin modal (no overlay of its own). On mount it
 * fetches the current invites; the create form posts new invites and prepends
 * them, and each row can be copied to the clipboard or revoked.
 */
import { useCallback, useEffect, useState } from "react";
import { Section, Banner } from "@components/settings/controls";
import { Pager } from "@components/BugReportModal";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";
import { api } from "@lib/services";
import { copyText } from "@lib/clipboard";
import type { InviteResponse } from "@lib/types";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

const PAGE_SIZE = 25;

/** Parse a number field where empty/0 means "no limit". Returns undefined when blank/zero. */
function parseLimit(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function formatExpiry(expiresAt: string | null): string {
  if (expiresAt === null) return t("admin.never");
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return expiresAt;
  return new Date(ts).toLocaleString();
}

function formatUses(invite: InviteResponse): string {
  const used = invite.use_count ?? 0;
  const max = invite.max_uses;
  return max === null ? `${used} / ∞` : `${used} / ${max}`;
}

export function InviteManager() {
  const [invites, setInvites] = useState<readonly InviteResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [maxUses, setMaxUses] = useState("");
  const [expiresHours, setExpiresHours] = useState("");
  const [creating, setCreating] = useState(false);

  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback((signal?: AbortSignal): void => {
    setLoading(true);
    void api
      .getInvitesPaged(PAGE_SIZE, (page - 1) * PAGE_SIZE, signal)
      .then((r) => {
        setInvites(r.items);
        setTotal(r.total);
        setError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setError(errMsg(e, t("admin.failedLoadInvites")));
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, [page]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Clear the transient "Copied" highlight after a moment.
  useEffect(() => {
    if (copiedCode === null) return;
    const timer = window.setTimeout(() => setCopiedCode(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedCode]);

  const create = () => {
    setError(null);
    setSuccess(null);
    setCreating(true);
    const data: { max_uses?: number; expires_in_hours?: number } = {};
    const mu = parseLimit(maxUses);
    if (mu !== undefined) data.max_uses = mu;
    const eh = parseLimit(expiresHours);
    if (eh !== undefined) data.expires_in_hours = eh;
    void api
      .createInvite(data)
      .then((invite) => {
        setMaxUses("");
        setExpiresHours("");
        setSuccess(t("admin.inviteCreated", { code: invite.code }));
        if (page === 1) load(); else setPage(1); // the new invite sorts first
      })
      .catch((e: unknown) => setError(errMsg(e, t("admin.failedCreateInvite"))))
      .finally(() => setCreating(false));
  };

  const copy = (invite: InviteResponse) => {
    // invite.url may be absent — fall back to the raw code (crashing on .length here is
    // exactly what silently broke Copy).
    const text = invite.url && invite.url.length > 0 ? invite.url : invite.code;
    void copyText(text).then((ok) => {
      if (ok) { setCopiedCode(invite.code); setError(null); }
      else setError(t("admin.failedCopyClipboard"));
    });
  };

  const revoke = (code: string) => {
    setError(null);
    setSuccess(null);
    setRevoking(code);
    void api
      .revokeInvite(code)
      .then(() => {
        setSuccess(t("admin.inviteRevoked", { code }));
        load();
      })
      .catch((e: unknown) => setError(errMsg(e, t("admin.failedRevokeInvite"))))
      .finally(() => setRevoking(null));
  };

  return (
    <div className="settings-pane active">
      <Section title={t("admin.createInvite")} />
      <div className="setting-row">
        <div>
          <div className="setting-label">{t("admin.maxUses")}</div>
          <div className="setting-desc">{t("admin.maxUsesDesc")}</div>
        </div>
        <input
          className="form-input"
          type="number"
          min={0}
          placeholder={t("admin.unlimited")}
          style={{ width: 140 }}
          value={maxUses}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxUses(e.target.value)}
        />
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">{t("admin.expiresInHours")}</div>
          <div className="setting-desc">{t("admin.expiresInHoursDesc")}</div>
        </div>
        <input
          className="form-input"
          type="number"
          min={0}
          placeholder={t("admin.never")}
          style={{ width: 140 }}
          value={expiresHours}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setExpiresHours(e.target.value)}
        />
      </div>
      <button className="ac-btn" disabled={creating} onClick={create}>
        {creating ? t("admin.creating") : t("admin.createInvite")}
      </button>

      {error && <Banner kind="error">{error}</Banner>}
      {success && <Banner kind="success">{success}</Banner>}

      <Section title={t("admin.activeInvites")} />
      {loading ? (
        <Banner kind="info">{t("admin.loadingInvites")}</Banner>
      ) : invites.length === 0 ? (
        <Banner kind="info">{t("admin.noActiveInvites")}</Banner>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {invites.map((invite) => {
            const busy = revoking === invite.code;
            const copied = copiedCode === invite.code;
            return (
              <div
                key={invite.id}
                className="setting-row"
                style={{ alignItems: "center", gap: 12 }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: 14,
                      color: "var(--text-primary)",
                      wordBreak: "break-all",
                    }}
                  >
                    {invite.code}
                  </div>
                  <div className="setting-desc">
                    {t("admin.usesLabel")} {formatUses(invite)} · {t("admin.expiresLabel")} {formatExpiry(invite.expires_at)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    className="ac-btn"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                    onClick={() => copy(invite)}
                  >
                    <Icon name={copied ? "check" : "send"} size={14} />
                    {copied ? t("admin.copied") : t("admin.copy")}
                  </button>
                  <button
                    className="ac-btn account-delete-btn"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                    disabled={busy}
                    onClick={() => revoke(invite.code)}
                  >
                    <Icon name="trash-2" size={14} />
                    {busy ? t("admin.revoking") : t("admin.revoke")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Pager page={Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE)))} pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
    </div>
  );
}
