/**
 * Active sessions list — renders inline inside AccountTab. Loads the current
 * user's active login sessions (GET /users/me/sessions) and lets the user
 * revoke any of them (DELETE /users/me/sessions/{id}). The session backing the
 * current token is marked and its Revoke button disabled.
 *
 * Restores UI for an endpoint the backend already exposes but nothing surfaced.
 */
import { useEffect, useState } from "react";
import { Section, Banner } from "@components/settings/controls";
import { api } from "@lib/services";
import { Icon } from "@lib/icons";
import { confirm } from "@components/ConfirmDialog";
import type { SessionResponse } from "@lib/types";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Human-readable absolute date/time, or "—" for unparseable input. */
function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The typed `SessionResponse` does not declare a current-session flag, but the
 * backend may include one. Read it defensively without widening the type.
 */
function isCurrentSession(s: SessionResponse): boolean {
  const extra = s as unknown as Record<string, unknown>;
  return extra["current"] === true || extra["is_current"] === true;
}

/** A readable label for a session: its device/user-agent, else a fallback. */
function sessionLabel(s: SessionResponse): string {
  const device = s.device?.trim();
  if (device && device.length > 0) return device;
  return `Session #${s.id}`;
}

export function SessionsList() {
  const [sessions, setSessions] = useState<readonly SessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .getSessions(controller.signal)
      .then((list) => {
        setSessions(list);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(errMsg(e, "Failed to load sessions."));
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const revoke = (id: number) => {
    setRevoking(id);
    setError(null);
    void api
      .revokeSession(id)
      .then(() => {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setRevoking(null);
      })
      .catch((e: unknown) => {
        setError(errMsg(e, "Failed to revoke session."));
        setRevoking(null);
      });
  };

  const others = sessions.filter((s) => !isCurrentSession(s)).length;

  const revokeAll = async () => {
    if (!(await confirm({
      title: "Revoke all other sessions?",
      message: `This signs you out on ${others} other device${others === 1 ? "" : "s"}. The session you're using now stays.`,
      confirmLabel: "Revoke all",
      danger: true,
    }))) return;
    setRevoking(-1);
    setError(null);
    try {
      await api.revokeAllSessions();
      setSessions((prev) => prev.filter((s) => isCurrentSession(s)));
    } catch (e) {
      setError(errMsg(e, "Failed to revoke sessions."));
    }
    setRevoking(null);
  };

  return (
    <>
      <Section title="Active sessions" />
      {/* 130 stale logins have no business being clicked away one at a time. */}
      {!loading && others > 0 && (
        <div className="setting-row" style={{ alignItems: "center", marginBottom: 10 }}>
          <div className="setting-desc">
            {sessions.length} active session{sessions.length === 1 ? "" : "s"} — {others} on other devices.
          </div>
          <button
            type="button"
            className="ac-btn account-delete-btn"
            disabled={revoking !== null}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
            onClick={() => void revokeAll()}
          >
            <Icon name="trash-2" size={14} />
            {revoking === -1 ? "Revoking…" : "Revoke all"}
          </button>
        </div>
      )}
      {error && <Banner kind="error">{error}</Banner>}
      {loading ? (
        <Banner kind="info">Loading sessions…</Banner>
      ) : sessions.length === 0 ? (
        <Banner kind="info">No active sessions.</Banner>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sessions.map((s) => {
            const current = isCurrentSession(s);
            const busy = revoking === s.id;
            return (
              <div
                key={s.id}
                className="setting-row"
                style={{
                  alignItems: "center",
                  background: "var(--bg-active)",
                  borderRadius: 6,
                  padding: "10px 12px",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    className="setting-label"
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {sessionLabel(s)}
                    </span>
                    {current && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "var(--green, #3ba55d)",
                          color: "#fff",
                          flexShrink: 0,
                        }}
                      >
                        This device
                      </span>
                    )}
                  </div>
                  <div className="setting-desc">
                    {s.ip_address ? `${s.ip_address} · ` : ""}
                    Last active {formatStamp(s.last_used)} · Signed in{" "}
                    {formatStamp(s.created_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="ac-btn account-delete-btn"
                  disabled={current || busy}
                  title={current ? "You cannot revoke the session you're using." : "Revoke this session"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    opacity: current ? 0.5 : 1,
                    cursor: current ? "not-allowed" : undefined,
                  }}
                  onClick={() => revoke(s.id)}
                >
                  <Icon name="trash-2" size={14} />
                  {busy ? "Revoking…" : "Revoke"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
