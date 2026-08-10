import { useEffect, useRef, useState } from "react";
import { useStoreState } from "@lib/useStore";
import { voiceStore } from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { leaveVoiceNow, toggleMute, toggleDeafen, joinVoice } from "@lib/voice";
import {
  enableCamera, disableCamera, enableScreenshare, disableScreenshare,
  setOnRemoteVideo, setOnRemoteVideoRemoved, clearOnRemoteVideo,
  getLocalCameraStream, getLocalScreenshareStream,
} from "@lib/livekitSession";
import { Icon, type IconName } from "@lib/icons";
import { api } from "@lib/services";
import { copyText } from "@lib/clipboard";
import { setTransientSuccess, showToast } from "@stores/ui.store";
import { Avatar } from "@components/Avatar";
import { QualityBars } from "@components/QualityBars";
import { t } from "@lib/i18n";
import { VoiceUserMenu } from "@components/VoiceUserMenu";

interface RemoteEntry { userId: number; stream: MediaStream; screenshare: boolean }

/**
 * Full Discord-style voice view rendered in the main content area when the active channel is a
 * voice channel: a tile per participant (avatar or live camera, speaking ring, mute/deafen badges),
 * dedicated tiles for screenshares, and a bottom control bar with a prominent Disconnect.
 */
export function VoiceStage({ channelId }: { channelId: number }) {
  // Mint (or fetch) the channel's no-login guest link and drop it in the clipboard.
  // Permission (ManageInvites) is enforced server-side — a 403 lands in the toast.
  const copyGuestLink = (): void => {
    void api.createGuestLink(channelId)
      .then(async (r) => {
        if (await copyText(r.url)) setTransientSuccess(t("voice.guestLinkCopied"));
        else showToast(r.url, "info"); // clipboard blocked — at least show it
      })
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : t("voice.guestLinkFailed"), "error"));
  };

  const v = useStoreState(voiceStore);
  useStoreState(membersStore);
  const authUser = useStoreState(authStore).user;
  const me = authUser?.id ?? 0;
  const connectedHere = v.currentChannelId === channelId;
  const [remote, setRemote] = useState<ReadonlyMap<string, RemoteEntry>>(new Map());
  const [vMenu, setVMenu] = useState<{ userId: number; x: number; y: number } | null>(null);

  useEffect(() => {
    setOnRemoteVideo((userId, stream, isSs) =>
      setRemote((m) => {
        const n = new Map(m);
        n.set(`${userId}:${isSs ? "ss" : "cam"}`, { userId, stream, screenshare: isSs });
        return n;
      }));
    setOnRemoteVideoRemoved((userId, isSs) =>
      setRemote((m) => {
        const n = new Map(m);
        n.delete(`${userId}:${isSs ? "ss" : "cam"}`);
        return n;
      }));
    return () => clearOnRemoteVideo();
  }, []);

  const users = Array.from((v.voiceUsers.get(channelId) ?? new Map<number, never>()).values());

  const cameraFor = (userId: number): MediaStream | null => {
    if (userId === me) return v.localCamera ? getLocalCameraStream() : null;
    return remote.get(`${userId}:cam`)?.stream ?? null;
  };

  // Screenshares get their own wide tiles (local first, then remotes).
  const screens: Array<{ key: string; label: string; stream: MediaStream }> = [];
  if (v.localScreenshare && me) {
    const s = getLocalScreenshareStream();
    if (s) screens.push({ key: "local-ss", label: t("voice.yourScreen"), stream: s });
  }
  for (const [k, r] of remote) {
    if (!r.screenshare) continue;
    const u = users.find((x) => x.userId === r.userId);
    screens.push({ key: k, label: t("voice.userScreen", { name: u?.username ?? "user " + r.userId }), stream: r.stream });
  }

  // Meet-style sizing: without a screenshare the participant grid fills the whole canvas —
  // the column count follows the crowd (1 person = full screen, 4 = 2×2, …); with one, the
  // participants collapse into a bottom strip and the share takes everything else.
  const tileCols = screens.length > 0
    ? Math.min(Math.max(users.length, 1), 6)
    : Math.min(Math.ceil(Math.sqrt(Math.max(users.length, 1))), 4);

  return (
    <div className="voice-stage">
      <div className="voice-stage-body">
        {screens.length > 0 && (
          <div className="vstage-screens">
            {screens.map((s) => <VideoBox key={s.key} label={s.label} stream={s.stream} contain expandable />)}
          </div>
        )}
        <div
          className={"vstage-grid" + (screens.length > 0 ? " strip" : "")}
          style={{ "--tile-cols": tileCols } as React.CSSProperties}
        >
          {users.length === 0 && <div className="vstage-empty">{t("voice.emptyChannel")}</div>}
          {users.map((u) => {
            const cam = cameraFor(u.userId);
            return (
              <div
                key={u.userId}
                className={"vstage-tile" + (u.speaking ? " speaking" : "")}
                onContextMenu={(e) => { e.preventDefault(); setVMenu({ userId: u.userId, x: e.clientX, y: e.clientY }); }}
              >
                {cam
                  ? <VideoBox label="" stream={cam} fill mirror={u.userId === me} />
                  : <Avatar
                      username={u.username}
                      avatar={u.userId === me ? (authUser?.avatar ?? null) : u.avatar}
                      size={96}
                      color="#5865f2"
                      className="vstage-avatar"
                    />}
                <div className="vstage-name">
                  <QualityBars quality={v.connQuality.get(u.userId)} size={11} />
                  {u.muted && <span className="vstage-badge muted" title={t("voice.muted")}><Icon name="mic-off" size={12} /></span>}
                  {u.deafened && <span className="vstage-badge deaf" title={t("voice.deafened")}><Icon name="volume-x" size={12} /></span>}
                  <span className="vstage-name-text">{u.username}{u.userId === me ? ` ${t("voice.youSuffix")}` : ""}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="vstage-controls">
        {connectedHere ? (
          <>
            <Ctl name={v.localMuted ? "mic-off" : "mic"} label={v.localMuted ? t("voice.unmuteLabel") : t("voice.micLabel")} red={v.localMuted} onClick={toggleMute} />
            <Ctl name={v.localDeafened ? "headphones-off" : "headphones"} label={v.localDeafened ? t("voice.undeafenLabel") : t("voice.soundLabel")} red={v.localDeafened} onClick={toggleDeafen} />
            <Ctl name={v.localCamera ? "camera-off" : "camera"} label={v.localCamera ? t("voice.stopVideoLabel") : t("voice.videoLabel")} on={v.localCamera} onClick={() => { if (v.localCamera) void disableCamera(); else void enableCamera(); }} />
            <Ctl name={v.localScreenshare ? "monitor-off" : "monitor"} label={v.localScreenshare ? t("voice.stopShareLabel") : t("voice.screenLabel")} on={v.localScreenshare} onClick={() => { if (v.localScreenshare) void disableScreenshare(); else void enableScreenshare(); }} />
            <Ctl name="user-plus" label={t("voice.guestLinkLabel")} onClick={copyGuestLink} />
            <button className="vsc-btn disconnect" title={t("voice.disconnectFromVoice")} onClick={leaveVoiceNow}><Icon name="phone-down" size={18} /> {t("voice.disconnect")}</button>
          </>
        ) : (
          <button className="vsc-join" onClick={() => joinVoice(channelId)}><Icon name="volume-2" size={18} /> {t("voice.joinVoice")}</button>
        )}
      </div>
      {vMenu && (
        <VoiceUserMenu userId={vMenu.userId} x={vMenu.x} y={vMenu.y} onClose={() => setVMenu(null)} />
      )}
    </div>
  );
}

/** A captioned circular control button (icon + label) for the voice control bar. */
function Ctl({ name, label, on, red, onClick }: { name: IconName; label: string; on?: boolean; red?: boolean; onClick: () => void }) {
  const cls = "vsc-btn" + (red ? " on-red" : on ? " on" : "");
  return (
    <div className="vsc-ctl">
      <button className={cls} title={label} onClick={onClick}><Icon name={name} size={22} /></button>
      <span className="vsc-ctl-label">{label}</span>
    </div>
  );
}

function VideoBox({ label, stream, fill, contain, mirror, expandable }: { label: string; stream: MediaStream; fill?: boolean; contain?: boolean; mirror?: boolean; expandable?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // getLocal*Stream() wraps the live track in a NEW MediaStream every render, so
    // compare by the underlying video-track id and only reset srcObject when the
    // actual track changes — otherwise the <video> resets/flickers every render.
    const cur = el.srcObject as MediaStream | null;
    const newId = stream.getVideoTracks()[0]?.id ?? "";
    const curId = cur?.getVideoTracks()[0]?.id ?? "";
    if (newId !== curId) {
      el.srcObject = stream;
      el.play().catch(() => { /* autoplay may need a gesture */ });
    }
  }, [stream]);

  // Someone else's screen inside a 260px-narrower panel is a screen you squint at. The
  // browser's own fullscreen is the widest it can get and costs no layout surgery — the
  // whole display, on any monitor, and Escape gets you out.
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFull = (): void => {
    const el = boxRef.current;
    if (el === null) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    // The label rides along because the wrapper goes fullscreen, not the bare <video>.
    else void el.requestFullscreen().catch(() => { /* denied or unsupported — stay inline */ });
  };

  return (
    <div
      ref={boxRef}
      className={"vstage-video" + (fill ? " fill" : "") + (expandable === true ? " expandable" : "")}
      onDoubleClick={expandable === true ? toggleFull : undefined}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", height: "100%", objectFit: contain ? "contain" : "cover", transform: mirror ? "scaleX(-1)" : undefined }}
      />
      {expandable === true && (
        <button
          className="vstage-expand"
          title={full ? t("voice.exitFullscreen") : t("voice.fullscreen")}
          aria-label={full ? t("voice.exitFullscreen") : t("voice.fullscreen")}
          onClick={(e) => { e.stopPropagation(); toggleFull(); }}
        >
          <Icon name={full ? "minimize" : "maximize"} size={16} />
        </button>
      )}
      {label && <div className="vstage-video-label">{label}</div>}
    </div>
  );
}
