/**
 * AdminDashboard — admin diagnostics pane. Loads server statistics from
 * api.getServerStats() on mount (and on demand via a Refresh button) and
 * renders them as a grid of stat cards (users, messages, channels, servers,
 * invites, online, DB size, uptime, version). Human-friendly formatting for
 * byte sizes and durations is done locally.
 */
import { useEffect, useState } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Banner } from "@components/settings/controls";
import { Badge, IconBtn, Spacer, Spinner, Toolbar } from "@components/admin/kit";
import { Icon, type IconName } from "@lib/icons";
import type { AdminStatsResponse, ServiceHealthResponse } from "@lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(e: unknown, f: string): string {
  return e instanceof Error ? e.message : f;
}

/** Format a byte count as a human-readable B/KB/MB/GB string. */
function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Format a duration in seconds as a compact human-readable string. */
function humanDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "0s";
  const total = Math.floor(secs);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Stat card metadata (built from the loaded stats).
// ---------------------------------------------------------------------------

interface StatCard {
  readonly key: string;
  readonly value: string;
  readonly label: string;
  readonly icon: IconName;
}

function buildCards(stats: AdminStatsResponse): readonly StatCard[] {
  return [
    { key: "users", icon: "users", value: String(stats.user_count), label: t("admin.statUsers") },
    { key: "messages", icon: "message-circle", value: String(stats.message_count), label: t("admin.statMessages") },
    { key: "channels", icon: "hash", value: String(stats.channel_count), label: t("admin.statChannels") },
    { key: "servers", icon: "server", value: String(stats.server_count), label: t("admin.statServers") },
    { key: "invites", icon: "user-plus", value: String(stats.invite_count), label: t("admin.statInvites") },
    { key: "online", icon: "signal", value: String(stats.online_count), label: t("admin.statOnline") },
    { key: "db", icon: "file-text", value: humanBytes(stats.db_size_bytes), label: t("admin.statDbSize") },
    { key: "uptime", icon: "zap", value: humanDuration(stats.uptime_seconds), label: t("admin.statUptime") },
    { key: "version", icon: "settings", value: stats.version, label: t("admin.statVersion") },
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminDashboard() {
  const [stats, setStats] = useState<AdminStatsResponse | null>(null);
  const [health, setHealth] = useState<ServiceHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = (signal?: AbortSignal): void => {
    setLoading(true);
    setError(null);
    void api.getServiceHealth(signal).then((h) => { if (!signal?.aborted) setHealth(h); }).catch(() => { /* health is best-effort */ });
    void api
      .getServerStats(signal)
      .then((next) => {
        if (signal?.aborted) return;
        setStats(next);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setError(errMsg(e, t("admin.failedLoadStats")));
        setLoading(false);
      });
  };

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, []);

  const cards = stats ? buildCards(stats) : [];

  const allOk = health?.services.every((x) => x.ok) ?? true;

  return (
    <div className="settings-pane active">
      <Toolbar>
        {health && (
          <Badge tone={allOk ? "success" : "danger"} dot>{allOk ? t("admin.allSystemsOk") : t("admin.someSystemsDown")}</Badge>
        )}
        <Spacer />
        <IconBtn icon="refresh-cw" label={t("admin.refresh")} disabled={loading} onClick={() => load()} />
      </Toolbar>

      {error && <Banner kind="error">{error}</Banner>}

      {health && (
        <div className="admin-health">
          <div className="admin-health-node">
            <span className="ahn-dot" data-ok={allOk} />
            <span>{t("admin.thisNode")}: <code>{health.node.hostname}</code></span>
            <span className="ahn-meta">{health.node.online_here} {t("admin.socketsHere")}</span>
            {health.node.redis_backplane && <span className="ahn-badge">{t("admin.redisBackplane")}</span>}
          </div>
          <div className="admin-health-grid">
            {health.services.map((x) => (
              <div className={"admin-health-card" + (x.ok ? " ok" : " down")} key={x.name} title={x.error ?? ""}>
                <span className="ahc-dot" />
                <span className="ahc-name">{x.name}</span>
                <span className="ahc-status">{x.ok ? (x.error ? x.error : `${t("admin.up")} · ${x.ms}ms`) : t("admin.down")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && !stats ? (
        <div className="adm-loading"><Spinner size={20} /></div>
      ) : stats ? (
        <div className="admin-stat-grid">
          {cards.map((card) => (
            <div className="admin-stat-card" key={card.key}>
              <span className="asc-icon"><Icon name={card.icon} size={16} /></span>
              <div className="asc-value">{card.value}</div>
              <div className="asc-label">{card.label}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
