import { useEffect, useState } from "react";
import { useStoreState } from "@lib/useStore";
import { voiceStore, getChannelVoiceUsers } from "@stores/voice.store";
import { channelsStore, setActiveChannel, setPendingChannel } from "@stores/channels.store";
import { getActiveServerId } from "@stores/servers.store";
import { setSidebarMode } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { closeDrawer } from "@stores/mobile.store";
import { switchServer } from "@lib/session";
import { leaveVoiceNow, toggleMute, toggleDeafen } from "@lib/voice";
import { enableCamera, disableCamera, enableScreenshare, disableScreenshare, unlockAudio } from "@lib/livekitSession";
import { Avatar } from "@components/Avatar";
import { QualityBars } from "@components/QualityBars";
import { Icon } from "@lib/icons";
import { t } from "@lib/i18n";

/** Format elapsed milliseconds as m:ss (or h:mm:ss past an hour). */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Floating voice dock — a media-player-style card that detaches from the sidebar and
 * floats over the app (bottom-left, above the user bar) while connected. Because it lives
 * at the app root (not inside the Sidebar), it stays visible across every view — channels,
 * Home/DMs, and even when browsing a different server — so leave/mute is always one click
 * away. Shows the live channel, elapsed time, participant faces (with speaking rings), and
 * the transport controls.
 */
export function VoiceWidget() {
  const v = useStoreState(voiceStore);
  useStoreState(channelsStore);
  const auth = useStoreState(authStore);
  const [now, setNow] = useState(0);

  // Tick the elapsed timer once per second while connected.
  useEffect(() => {
    if (v.currentChannelId == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [v.currentChannelId]);

  if (v.currentChannelId == null) return null;

  const channelId = v.currentChannelId;
  const ch = channelsStore.getState().channels.get(channelId);
  const elapsed = v.joinedAt != null ? now - v.joinedAt : 0;
  const users = getChannelVoiceUsers(channelId) ?? [];
  const shown = users.slice(0, 6);
  const extra = users.length - shown.length;

  /** Open the full voice view for the connected channel. If we're browsing a DIFFERENT
   *  space, the channel isn't loaded here — switch to its owning server first and let the
   *  scoped READY select it (setPendingChannel), instead of blanking to an empty channel. */
  function openStage(): void {
    setSidebarMode("channels");
    const owner = v.connectedServerId;
    if (owner != null && owner !== getActiveServerId()) {
      setPendingChannel(channelId);
      switchServer(owner);
    } else {
      setActiveChannel(channelId);
    }
    closeDrawer();
  }

  return (
    <div className="voice-dock">
      <div className="vd-header">
        <span className="vd-live"><span className="vd-live-dot" />{t("voice.voiceConnected")}</span>
        <QualityBars quality={auth.user ? v.connQuality.get(auth.user.id) : undefined} size={12} />
        <span className="vd-timer">{fmtElapsed(elapsed)}</span>
        <button
          className="vd-popout"
          title={t("voice.openVoiceView")}
          onClick={openStage}
        ><Icon name="external-link" size={13} /></button>
      </div>

      <div className="vd-channel">
        <Icon name="volume-2" size={13} />
        <span className="vd-channel-name">{ch?.name ?? ""}</span>
        {v.listenOnly && <span className="vd-listen">{t("voice.listenOnly")}</span>}
        {/* Only worth showing when it is NOT the good path: udp is unremarkable, tcp and relay
            explain a call that sounds ragged on mobile data. */}
        {v.transport != null && v.transport !== "udp" && (
          <span className="vd-transport" title={t("voice.transportHint")}>{v.transport}</span>
        )}
      </div>

      {v.audioBlocked && (
        <button className="vd-unblock" onClick={() => void unlockAudio()}>
          <Icon name="volume-2" size={13} /> {t("voice.enableSound")}
        </button>
      )}

      {shown.length > 0 && (
        <div className="vd-faces">
          {shown.map((u) => {
            const q = v.connQuality.get(u.userId);
            const degraded = q === "poor" || q === "lost";
            return (
              <span key={u.userId} className={"vd-face" + (u.speaking ? " speaking" : "")}
                title={u.username + (degraded ? ` — ${q === "lost" ? t("voice.qualityLost") : t("voice.qualityPoor")}` : "")}>
                <Avatar
                  username={u.username}
                  avatar={u.userId === auth.user?.id ? (auth.user?.avatar ?? null) : u.avatar}
                  size={26}
                  color="#5865f2"
                />
                {u.muted && <span className="vd-face-muted"><Icon name="mic-off" size={9} /></span>}
                {/* Signal warning only when DEGRADED — green dots on everyone would be noise. */}
                {degraded && <span className={`vd-face-signal q-${q}`} />}
              </span>
            );
          })}
          {extra > 0 && <span className="vd-face-more">+{extra}</span>}
        </div>
      )}

      <div className="vd-controls">
        <button
          className={v.localMuted ? "active-ctrl" : ""}
          title={v.localMuted ? t("voice.unmute") : t("voice.mute")}
          onClick={toggleMute}
        ><Icon name={v.localMuted ? "mic-off" : "mic"} size={17} /></button>
        <button
          className={v.localDeafened ? "active-ctrl" : ""}
          title={v.localDeafened ? t("voice.undeafen") : t("voice.deafen")}
          onClick={toggleDeafen}
        ><Icon name={v.localDeafened ? "headphones-off" : "headphones"} size={17} /></button>
        <button
          className={v.localCamera ? "on-ctrl" : ""}
          title={t("voice.camera")}
          onClick={() => { if (v.localCamera) void disableCamera(); else void enableCamera(); }}
        ><Icon name={v.localCamera ? "camera-off" : "camera"} size={17} /></button>
        <button
          className={v.localScreenshare ? "on-ctrl" : ""}
          title={t("voice.shareScreen")}
          onClick={() => { if (v.localScreenshare) void disableScreenshare(); else void enableScreenshare(); }}
        ><Icon name={v.localScreenshare ? "monitor-off" : "monitor"} size={17} /></button>
        <button className="vd-leave" title={t("voice.disconnect")} onClick={leaveVoiceNow}><Icon name="phone-down" size={17} /></button>
      </div>
    </div>
  );
}
