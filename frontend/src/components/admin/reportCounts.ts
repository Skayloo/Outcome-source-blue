/**
 * How many complaints and block notices nobody has looked at yet — the counts beside "Жалобы" and
 * "Блокировки". Asked once a minute, and again at once whenever a queue acts on an entry (it fires
 * REPORTS_CHANGED_EVENT).
 */
import { useEffect, useState } from "react";
import { api } from "@lib/services";
import type { OpenReportCounts } from "@lib/types";

export const REPORTS_CHANGED_EVENT = "outcome:reports-changed";

/** Tell the counts that a queue changed something (status, hidden, removed, answered). */
export function reportsChanged(): void {
  window.dispatchEvent(new Event(REPORTS_CHANGED_EVENT));
}

/** `instance`: the space's whole queue (/admin). `server`: the active server's own. `enabled`
 *  false for someone who may not read the queue — they would only be refused once a minute. */
export function useOpenReportCounts(scope: "instance" | "server", enabled = true): OpenReportCounts {
  const [counts, setCounts] = useState<OpenReportCounts>({ reports: 0, blocks: 0 });
  useEffect(() => {
    if (!enabled) return;
    const ask = (): void => {
      if (document.hidden) return;
      void (scope === "server" ? api.serverReportCounts() : api.adminReportCounts())
        .then(setCounts)
        .catch(() => { /* a count is not worth an error */ });
    };
    ask();
    const timer = window.setInterval(ask, 60_000);
    window.addEventListener(REPORTS_CHANGED_EVENT, ask);
    return () => { window.clearInterval(timer); window.removeEventListener(REPORTS_CHANGED_EVENT, ask); };
  }, [scope, enabled]);
  return counts;
}
