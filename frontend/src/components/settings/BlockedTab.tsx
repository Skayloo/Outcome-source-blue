/**
 * Settings → Blocked users. The list of people this account has blocked, with a one-click
 * unblock. Blocking itself happens from the member list / a profile — this pane is the
 * place to undo it (and the place App Review looks for it).
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Section, Banner } from "@components/settings/controls";
import { Avatar } from "@components/Avatar";
import { Icon } from "@lib/icons";
import type { BlockedUserDto } from "@lib/types";

function errMsg(e: unknown, f: string): string {
  return e instanceof Error ? e.message : f;
}

export function BlockedTab() {
  const [blocked, setBlocked] = useState<BlockedUserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal): void => {
    setLoading(true);
    void api
      .listBlocked(signal)
      .then((list) => { setBlocked(list); setError(null); })
      .catch((e: unknown) => { if (!signal?.aborted) setError(errMsg(e, t("settings.blockedLoadFailed"))); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, []);

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);

  const unblock = (u: BlockedUserDto): void => {
    setBusy(u.user_id);
    setError(null);
    void api
      .unblockUser(u.user_id)
      .then(() => setBlocked((prev) => prev.filter((x) => x.user_id !== u.user_id)))
      .catch((e: unknown) => setError(errMsg(e, t("settings.unblockFailed"))))
      .finally(() => setBusy(null));
  };

  return (
    <div className="settings-pane active">
      <Section title={t("settings.navBlocked")} />
      <div className="setting-desc" style={{ marginBottom: 12 }}>{t("settings.blockedDesc")}</div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <Banner kind="info">{t("settings.blockedLoading")}</Banner>
      ) : blocked.length === 0 ? (
        <Banner kind="info">{t("settings.blockedEmpty")}</Banner>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {blocked.map((u) => (
            <div key={u.user_id} className="setting-row" style={{ alignItems: "center", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                <Avatar username={u.username} avatar={u.avatar} size={32} color="#5865f2" />
                <div style={{ minWidth: 0 }}>
                  <div className="setting-label">{u.username}</div>
                  <div className="setting-desc">
                    {t("settings.blockedSince", { date: new Date(u.created_at).toLocaleDateString() })}
                  </div>
                </div>
              </div>
              <button className="ac-btn" disabled={busy === u.user_id} onClick={() => unblock(u)}>
                <Icon name="check" size={14} /> {busy === u.user_id ? t("settings.unblocking") : t("settings.unblock")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
