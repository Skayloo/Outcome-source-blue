/**
 * AdminLogsPanel — live Server-Sent-Events log viewer. On mount it fetches a
 * one-shot ticket (api.getLogTicket) and opens an EventSource against the
 * authenticated SSE stream. Incoming JSON lines are appended (capped at the last
 * 1000) and rendered with client-side level + text filtering. A paused ref —
 * checked inside the EventSource handler — lets the user freeze the feed without
 * tearing down and re-subscribing the stream.
 */
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Section, Banner } from "@components/settings/controls";
import { type AdminLogLine } from "@lib/types";

/** Maximum number of log lines retained in memory. */
const MAX_LINES = 1000;

export function AdminLogsPanel() {
  const [lines, setLines] = useState<AdminLogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState("All");
  const [query, setQuery] = useState("");

  // Mirror `paused` into a ref so the long-lived EventSource onmessage handler
  // reads the live value rather than a stale closure captured at subscribe time.
  const pausedRef = useRef<boolean>(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const boxRef = useRef<HTMLDivElement | null>(null);

  // Open the SSE stream once on mount; close it on unmount.
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    void api
      .getLogTicket()
      .then(({ ticket }) => {
        if (cancelled) return;
        es = new EventSource(api.adminLogStreamUrl(ticket));
        es.onopen = () => setConnected(true);
        es.onerror = () => setConnected(false);
        es.onmessage = (ev: MessageEvent<string>) => {
          if (pausedRef.current) return;
          let line: AdminLogLine;
          try {
            line = JSON.parse(ev.data) as AdminLogLine;
          } catch {
            return;
          }
          setLines((prev) => {
            const next = prev.length >= MAX_LINES ? prev.slice(prev.length - (MAX_LINES - 1)) : prev.slice();
            next.push(line);
            return next;
          });
        };
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });

    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, []);

  // Auto-scroll the log box (not the page) to the bottom as lines arrive.
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const onLevelChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setLevel(e.target.value);
  };

  const onQueryChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
  };

  const togglePaused = (): void => {
    setPaused((prev) => !prev);
  };

  const clearLines = (): void => {
    setLines([]);
  };

  const needle = query.toLowerCase();
  const filtered = lines.filter(
    (line) =>
      (level === "All" || line.level === level) &&
      (query === "" || (line.msg + line.source).toLowerCase().includes(needle)),
  );

  return (
    <div className="settings-pane active">
      <div className="admin-toolbar">
        <Section title={t("admin.serverLogs")} />
        <select className="form-input" value={level} onChange={onLevelChange}>
          <option value="All">{t("admin.all")}</option>
          <option value="INFORMATION">INFORMATION</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
        </select>
        <input
          className="form-input"
          type="text"
          placeholder={t("admin.searchLogs")}
          value={query}
          onChange={onQueryChange}
        />
        <span className="spacer" />
        <button className="ac-btn" type="button" onClick={togglePaused}>
          {t(paused ? "admin.resume" : "admin.pause")}
        </button>
        <button className="ac-btn" type="button" onClick={clearLines}>
          {t("admin.clear")}
        </button>
      </div>

      {!connected && (
        <Banner kind="error">
          {lines.length === 0 ? t("admin.connecting") : t("admin.logsDisconnected")}
        </Banner>
      )}

      <div className="admin-logs" ref={boxRef}>
        {filtered.map((line, i) => (
          <div className="admin-log-line" key={i}>
            <span className="all-ts">{new Date(line.ts).toLocaleTimeString()}</span>
            <span className={"all-lvl lvl-" + line.level}>{line.level}</span>
            <span className="all-src">{line.source}</span>
            {line.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
