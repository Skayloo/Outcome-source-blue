/**
 * Explore — public server directory. Lists servers owners marked public and lets the
 * user join them without an invite, then switches to the joined server.
 */
import { useEffect, useState } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { api } from "@lib/services";
import { serversStore, setServers } from "@stores/servers.store";
import { switchServer } from "@lib/session";
import { setSidebarMode } from "@stores/ui.store";
import { Icon } from "@lib/icons";
import { Avatar } from "@components/Avatar";
import { t } from "@lib/i18n";
import type { PublicServerDto } from "@lib/types";

export function ExploreModal({ onClose }: { onClose: () => void }) {
  const [servers, setList] = useState<PublicServerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<number | null>(null);

  useEffect(() => {
    const c = new AbortController();
    api.discoverServers(c.signal)
      .then((s) => { if (!c.signal.aborted) { setList(s); setLoading(false); } })
      .catch(() => { if (!c.signal.aborted) { setError(t("explore.loadFailed")); setLoading(false); } });
    return () => c.abort();
  }, []);

  const join = (s: PublicServerDto): void => {
    setJoining(s.id);
    void api.joinPublicServer(s.id)
      .then((srv) => {
        // Add to the rail + jump to it.
        const cur = serversStore.select((x) => x.servers);
        if (!cur.some((x) => x.id === srv.id)) setServers([...cur, srv]);
        setSidebarMode("channels");
        switchServer(srv.id);
        onClose();
      })
      .catch(() => setError(t("explore.joinFailed")))
      .finally(() => setJoining(null));
  };

  return (
    <ModalPortal>
      <div className="settings-overlay open" onClick={onClose}>
        <div className="explore-modal" onClick={(e) => e.stopPropagation()}>
          <div className="explore-header">
            <div>
              <h2>{t("explore.title")}</h2>
              <p>{t("explore.subtitle")}</p>
            </div>
            <button className="settings-close-btn" onClick={onClose}><Icon name="x" size={18} /></button>
          </div>

          {error && <div className="banner error">{error}</div>}

          {loading ? (
            <div className="dm-empty">{t("admin.loading")}</div>
          ) : servers.length === 0 ? (
            <div className="explore-empty">
              <Icon name="signal" size={32} />
              <p>{t("explore.empty")}</p>
            </div>
          ) : (
            <div className="explore-grid">
              {servers.map((s) => (
                <div className="explore-card" key={s.id}>
                  <div className="explore-card-top">
                    <Avatar username={s.name} avatar={s.icon} size={48} color="#5865f2" />
                    <div className="explore-card-info">
                      <div className="explore-card-name">{s.name}</div>
                      <div className="explore-card-members">
                        <span className="explore-dot" /> {s.member_count} {t("explore.members")}
                      </div>
                    </div>
                  </div>
                  <div className="explore-card-desc">{s.description || t("explore.noDescription")}</div>
                  <button
                    className="btn-primary explore-join"
                    disabled={joining === s.id}
                    onClick={() => join(s)}
                  >{joining === s.id ? t("explore.joining") : t("explore.join")}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
