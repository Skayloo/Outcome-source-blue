/**
 * Logs settings tab — log viewer with filtering, level control, live updates,
 * and a voice-diagnostics panel. Ported from the deprecated Tauri client's
 * LogsTab. Renders the in-memory log buffer, stays live via addLogListener,
 * and exposes copy/clear/refresh plus LiveKit session debug info.
 */
import { useEffect, useRef, useState } from "react";
import {
  getLogBuffer,
  clearLogBuffer,
  addLogListener,
  setLogLevel,
} from "@lib/logger";
import type { LogEntry, LogLevel } from "@lib/logger";
import { getSessionDebugInfo } from "@lib/livekitSession";
import { Section, Select } from "@components/settings/controls";
import { loadPref, savePref } from "@components/settings/helpers";
import { t } from "@lib/i18n";

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "#888",
  info: "#3ba55d",
  warn: "#faa61a",
  error: "#ed4245",
};

type FilterLevel = LogLevel | "all";

const FILTER_OPTIONS: { value: FilterLevel; label: string }[] = [
  { value: "all", label: "ALL" },
  { value: "debug", label: "DEBUG" },
  { value: "info", label: "INFO" },
  { value: "warn", label: "WARN" },
  { value: "error", label: "ERROR" },
];

const MIN_LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  { value: "debug", label: "DEBUG" },
  { value: "info", label: "INFO" },
  { value: "warn", label: "WARN" },
  { value: "error", label: "ERROR" },
];

const MIN_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function entryToText(e: LogEntry): string {
  const time = e.timestamp.slice(11, 23); // HH:MM:SS.mmm
  const level = e.level.toUpperCase().padEnd(5);
  const base = `${time} ${level} [${e.component}] ${e.message}`;
  if (e.data === undefined) return base;
  const dataStr =
    typeof e.data === "string" ? e.data : JSON.stringify(e.data, null, 2);
  return `${base}\n${dataStr}`;
}

export function LogsTab() {
  // Filter applies to displayed rows only (preserves deprecated `logs_filter_level`).
  const [filter, setFilter] = useState<FilterLevel>(() =>
    loadPref<FilterLevel>("logs_filter_level", "all"),
  );
  // Initial min-level: canonical `logMinLevel` (default "info").
  const initialMinLevel = useRef<LogLevel>(
    ((): LogLevel => {
      const saved = loadPref<string>("logMinLevel", "info");
      return MIN_LEVELS.includes(saved as LogLevel)
        ? (saved as LogLevel)
        : "info";
    })(),
  );

  const [entries, setEntries] = useState<readonly LogEntry[]>(() => [
    ...getLogBuffer(),
  ]);
  const [diag, setDiag] = useState<string>(() =>
    JSON.stringify(getSessionDebugInfo(), null, 2),
  );
  const [copyLabel, setCopyLabel] = useState(() => t("settings.copyAll"));
  const [diagCopyLabel, setDiagCopyLabel] = useState(() => t("settings.copyDiagnostics"));

  const listRef = useRef<HTMLDivElement | null>(null);

  // Apply the persisted min level on mount.
  useEffect(() => {
    setLogLevel(initialMinLevel.current);
  }, []);

  // Live updates: re-snapshot the buffer whenever a new entry arrives.
  useEffect(() => {
    const unsub = addLogListener(() => {
      setEntries([...getLogBuffer()]);
    });
    return unsub;
  }, []);

  // Auto-scroll to bottom when entries change.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const visible =
    filter === "all" ? entries : entries.filter((e) => e.level === filter);

  const onFilterChange = (v: string) => {
    const f = v as FilterLevel;
    setFilter(f);
    savePref("logs_filter_level", f);
  };

  const onMinLevelChange = (v: string) => {
    const level = v as LogLevel;
    setLogLevel(level);
    savePref("logMinLevel", level);
  };

  const refresh = () => setEntries([...getLogBuffer()]);

  const clear = () => {
    clearLogBuffer();
    setEntries([]);
  };

  const copyAll = () => {
    const text = visible.map(entryToText).join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => setCopyLabel(t("settings.copied")))
      .catch(() => setCopyLabel(t("settings.failedToCopy")))
      .finally(() => {
        window.setTimeout(() => setCopyLabel(t("settings.copyAll")), 1500);
      });
  };

  const refreshDiag = () => {
    setDiag(JSON.stringify(getSessionDebugInfo(), null, 2));
  };

  const copyDiag = () => {
    navigator.clipboard
      .writeText(diag)
      .then(() => setDiagCopyLabel(t("settings.copied")))
      .catch(() => setDiagCopyLabel(t("settings.failedToCopy")))
      .finally(() => {
        window.setTimeout(() => setDiagCopyLabel(t("settings.copyDiagnostics")), 1500);
      });
  };

  return (
    <div className="settings-pane active">
      <div
        style={{ fontSize: 12, color: "var(--text-muted)", margin: "-8px 0 12px 0" }}
      >
        {t("settings.clientVersion", { version: "web" })}
      </div>

      {/* Controls row */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span className="setting-label" style={{ margin: 0 }}>
          {t("settings.filter")}
        </span>
        <Select value={filter} options={FILTER_OPTIONS} onChange={onFilterChange} />

        <span className="setting-label" style={{ margin: "0 0 0 16px" }}>
          {t("settings.minLevel")}
        </span>
        <Select
          def={initialMinLevel.current}
          options={MIN_LEVEL_OPTIONS}
          onChange={onMinLevelChange}
        />

        <button className="ac-btn" style={{ marginLeft: "auto" }} onClick={copyAll}>
          {copyLabel}
        </button>
        <button className="ac-btn" onClick={clear}>
          {t("settings.clearLogs")}
        </button>
        <button className="ac-btn" onClick={refresh}>
          {t("settings.refresh")}
        </button>
      </div>

      {/* Voice diagnostics panel */}
      <Section title={t("settings.voiceDiagnostics")} />
      <pre
        style={{
          background: "var(--bg-tertiary)",
          borderRadius: 8,
          padding: 10,
          marginBottom: 12,
          fontFamily: "monospace",
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--text-muted)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {diag}
      </pre>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button className="ac-btn" onClick={refreshDiag}>
          {t("settings.refreshDiagnostics")}
        </button>
        <button className="ac-btn" onClick={copyDiag}>
          {diagCopyLabel}
        </button>
      </div>

      {/* Log count */}
      <div style={{ fontSize: 12, color: "#888", margin: "12px 0 4px 0" }}>
        {t("settings.entriesCount", { count: visible.length })}
      </div>

      {/* Log list (scrollable) */}
      <div
        ref={listRef}
        className="log-viewer"
        style={{
          maxHeight: "60vh",
          overflowY: "auto",
          background: "var(--bg-tertiary)",
          borderRadius: 8,
          padding: 8,
        }}
      >
        {visible.map((e, i) => {
          const color = LOG_LEVEL_COLORS[e.level];
          const time = e.timestamp.slice(11, 23);
          const level = e.level.toUpperCase().padEnd(5);
          const dataStr =
            e.data === undefined
              ? null
              : typeof e.data === "string"
                ? e.data
                : JSON.stringify(e.data, null, 2);
          return (
            <div
              key={i}
              className="log-entry"
              style={{
                borderLeft: `3px solid ${color}`,
                padding: "4px 8px",
                margin: "2px 0",
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              <span style={{ color }}>
                {`${time} ${level} [${e.component}] ${e.message}`}
              </span>
              {dataStr !== null && (
                <pre
                  style={{
                    margin: "2px 0 0 0",
                    color: "#999",
                    fontSize: 11,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {dataStr}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
