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
  onVoiceReaction, sendVoiceReaction, sendVoiceGif, setHandRaisedLocal,
} from "@lib/livekitSession";
import { Icon } from "@lib/icons";
import { copyGuestLink } from "@lib/guestLink";
import { Avatar } from "@components/Avatar";
import { QualityBars } from "@components/QualityBars";
import { t } from "@lib/i18n";
import { VoiceUserMenu } from "@components/VoiceUserMenu";
import { VoiceCtl as Ctl } from "@components/VoiceCtl";
import { FloatingReactions, VoiceFxControls, useReactionFeed } from "@components/VoiceFx";
import { type Reaction } from "@lib/voiceReactions";
import { messagesStore } from "@stores/messages.store";
import { channelsStore } from "@stores/channels.store";
import { MessageList } from "@components/MessageList";
import { MessageInput } from "@components/MessageInput";
import { TypingIndicator } from "@components/TypingIndicator";

import { recorderStore, startRecording, stopRecording, type RecordMode } from "@lib/recorder";

const CHAT_OPEN_KEY = "outcome:voiceChatOpen";

interface RemoteEntry { userId: number; stream: MediaStream; screenshare: boolean }

/**
 * Full Discord-style voice view rendered in the main content area when the active channel is a
 * voice channel: a tile per participant (avatar or live camera, speaking ring, mute/deafen badges),
 * dedicated tiles for screenshares, and a bottom control bar with a prominent Disconnect.
 */
export function VoiceStage({ channelId }: { channelId: number }) {
  const v = useStoreState(voiceStore);
  useStoreState(membersStore);
  const authUser = useStoreState(authStore).user;
  const me = authUser?.id ?? 0;
  const connectedHere = v.currentChannelId === channelId;
  const [remote, setRemote] = useState<ReadonlyMap<string, RemoteEntry>>(new Map());
  // Re-subscribed when the connection changes, because the room object behind it is replaced
  // on every join — a feed bound to the old one delivers nothing and says nothing.
  const reactions = useReactionFeed<number>((cb) => onVoiceReaction(cb), [connectedHere, v.currentChannelId]);
  const [vMenu, setVMenu] = useState<{ userId: number; x: number; y: number } | null>(null);

  // The room's own chat (W3GWG-25): the voice channel's messages, beside the call. Remembered
  // per browser, open or shut — a per-viewer convenience, nothing more.
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(CHAT_OPEN_KEY) === "1"; } catch { return false; }
  });
  const toggleChat = (): void => setChatOpen((v) => {
    try { localStorage.setItem(CHAT_OPEN_KEY, v ? "0" : "1"); } catch { /* private mode */ }
    return !v;
  });
  // New lines while the chat is shut: the badge on its button. The stage IS the active channel,
  // so the channel's own unread count never moves here — it is read the moment it arrives.
  // The room's chat is its attached text channel (W3GWG-25) — an ordinary channel of the same
  // name, so what is written here is there for everyone after the call, too.
  const chatId = useStoreState(channelsStore).channels.get(channelId)?.chatChannelId ?? channelId;
  const roomMsgs = useStoreState(messagesStore).messagesByChannel.get(chatId);
  const latestId = roomMsgs && roomMsgs.length > 0 ? roomMsgs[roomMsgs.length - 1]!.id : 0;
  const [seenId, setSeenId] = useState(latestId);
  useEffect(() => { if (chatOpen) setSeenId(latestId); }, [chatOpen, latestId]);
  const unseen = chatOpen ? 0 : (roomMsgs ?? []).filter((m) => m.id > seenId && m.user.id !== me && !m.deleted).length;

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

  const recUpload = useStoreState(recorderStore).uploading;
  // Who is recording this call — read by everyone, guests included (see lib/recorder.ts).
  const recNames = [...v.recorders.keys()].map((uid) =>
    users.find((u) => u.userId === uid)?.username ?? (uid === me ? authUser?.username ?? "" : t("rec.someone")));

  return (
    <div className="voice-stage">
      {connectedHere && v.recorders.size > 0 && (
        <div className="vstage-rec-banner" role="status">
          <span className="vstage-rec-dot" /> {t("rec.banner", { names: recNames.join(", ") })}
        </div>
      )}
      {recUpload !== null && (
        <div className="vstage-rec-banner uploading" role="status">
          {t("rec.uploading", { pct: Math.round(recUpload * 100) })}
        </div>
      )}
      <div className="voice-stage-main">
      <div className="voice-stage-body">
        {screens.length > 0 && (
          <div className="vstage-screens">
            {screens.map((s) => (
              <VideoBox
                key={s.key} label={s.label} stream={s.stream} contain expandable
                // Fullscreen covers the stage's own bar, and leaving fullscreen just to unmute
                // and answer a question is what people asked us to stop making them do.
                overlay={connectedHere ? <FullscreenControls /> : undefined}
              />
            ))}
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
                <FloatingReactions items={reactions.get(u.userId) ?? []} />
                {v.hands.has(u.userId) && (
                  <span className="vstage-hand" title={t("voice.handRaised")}>✋</span>
                )}
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
      {chatOpen && (
        <aside className="vstage-chat" aria-label={t("voice.roomChat")}>
          <div className="vstage-chat-head">
            <span>{t("voice.roomChat")}</span>
            <button className="vstage-chat-close" title={t("common.close")} aria-label={t("common.close")} onClick={toggleChat}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <MessageList channelId={chatId} />
          <TypingIndicator channelId={chatId} />
          <MessageInput channelId={chatId} />
        </aside>
      )}
      </div>

      <div className="vstage-controls">
        {connectedHere ? (
          <>
            <Ctl name={v.localMuted || v.localDeafened ? "mic-off" : "mic"} label={v.localMuted || v.localDeafened ? t("voice.unmuteLabel") : t("voice.micLabel")} red={v.localMuted || v.localDeafened} onClick={toggleMute} />
            <Ctl name={v.localDeafened ? "headphones-off" : "headphones"} label={v.localDeafened ? t("voice.undeafenLabel") : t("voice.soundLabel")} red={v.localDeafened} onClick={toggleDeafen} />
            {/* Icon = state, like the microphone: crossed and red while nobody can see you. */}
            <Ctl name={v.localCamera ? "camera" : "camera-off"} label={v.localCamera ? t("voice.stopVideoLabel") : t("voice.videoLabel")} on={v.localCamera} red={!v.localCamera} onClick={() => { if (v.localCamera) void disableCamera(); else void enableCamera(); }} />
            <Ctl name={v.localScreenshare ? "monitor-off" : "monitor"} label={v.localScreenshare ? t("voice.stopShareLabel") : t("voice.screenLabel")} on={v.localScreenshare} onClick={() => { if (v.localScreenshare) void disableScreenshare(); else void enableScreenshare(); }} />
            <VoiceFxControls
              handUp={v.hands.has(me)}
              onHand={(up) => { void setHandRaisedLocal(up); }}
              onReact={(emoji: Reaction) => { void sendVoiceReaction(emoji); }}
              onGif={(path) => { void sendVoiceGif(path); }}
            />
            <Ctl name="user-plus" label={t("voice.guestLinkLabel")} onClick={() => { void copyGuestLink(channelId); }} />
            <ChatToggle open={chatOpen} unseen={unseen} onClick={toggleChat} />
            {v.voiceConfigs.get(channelId)?.can_record === true && <RecordControl />}
            <button className="vsc-btn disconnect" title={t("voice.disconnectFromVoice")} onClick={leaveVoiceNow}><Icon name="phone-down" size={18} /> {t("voice.disconnect")}</button>
          </>
        ) : (
          <>
            <button className="vsc-join" onClick={() => joinVoice(channelId)}><Icon name="volume-2" size={18} /> {t("voice.joinVoice")}</button>
            {/* Readable from outside the call too: it is the channel's chat, not the call's. */}
            <ChatToggle open={chatOpen} unseen={unseen} onClick={toggleChat} />
          </>
        )}
      </div>
      {vMenu && (
        <VoiceUserMenu userId={vMenu.userId} x={vMenu.x} y={vMenu.y} onClose={() => setVMenu(null)} />
      )}
    </div>
  );
}

/** Start a recording in one of the agreed modes, or stop the one running. Shown only to those
 *  the server says may record (voice_config.can_record). */
function RecordControl() {
  const rec = useStoreState(recorderStore);
  const [menu, setMenu] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (rec.active === null) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [rec.active]);
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  if (rec.active !== null) {
    const secs = Math.floor((Date.now() - rec.active.startedAt) / 1000);
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    return <Ctl glyph="■" label={t("rec.stop", { time: clock })} red onClick={() => { void stopRecording(); }} />;
  }
  const modes: { mode: RecordMode; label: string }[] = [
    { mode: "audio", label: t("rec.modeAudio") },
    { mode: "video", label: t("rec.modeVideo") },
    { mode: "both", label: t("rec.modeBoth") },
    { mode: "separate", label: t("rec.modeSeparate") },
  ];
  return (
    <div className="vfx-picker-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <Ctl glyph="⏺" label={rec.busy ? t("rec.starting") : t("rec.record")} on={menu} onClick={() => { if (!rec.busy) setMenu((m) => !m); }} />
      {menu && (
        <div className="vfx-picker rec-menu" role="menu">
          {modes.map((m) => (
            <button key={m.mode} className="rec-menu-item" role="menuitem"
              onClick={() => { setMenu(false); void startRecording(m.mode); }}>{m.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The chat button of the control bar, with a count of what arrived while it was shut. */
function ChatToggle({ open, unseen, onClick }: { open: boolean; unseen: number; onClick: () => void }) {
  return (
    <div className="vsc-badged">
      <Ctl name="message-circle" label={t("voice.roomChat")} on={open} onClick={onClick} />
      {unseen > 0 && <span className="vsc-badge">{unseen > 99 ? "99+" : unseen}</span>}
    </div>
  );
}

/** The bar shown over a fullscreen screen share: what you reach for while watching one. */
function FullscreenControls() {
  const v = useStoreState(voiceStore);
  return (
    <div className="vstage-full-controls" onDoubleClick={(e) => e.stopPropagation()}>
      <Ctl name={v.localMuted || v.localDeafened ? "mic-off" : "mic"} label={v.localMuted || v.localDeafened ? t("voice.unmuteLabel") : t("voice.micLabel")} red={v.localMuted || v.localDeafened} onClick={toggleMute} />
      <Ctl name={v.localDeafened ? "headphones-off" : "headphones"} label={v.localDeafened ? t("voice.undeafenLabel") : t("voice.soundLabel")} red={v.localDeafened} onClick={toggleDeafen} />
      <Ctl name={v.localCamera ? "camera" : "camera-off"} label={v.localCamera ? t("voice.stopVideoLabel") : t("voice.videoLabel")} on={v.localCamera} red={!v.localCamera} onClick={() => { if (v.localCamera) void disableCamera(); else void enableCamera(); }} />
      <Ctl name={v.localScreenshare ? "monitor-off" : "monitor"} label={v.localScreenshare ? t("voice.stopShareLabel") : t("voice.screenLabel")} on={v.localScreenshare} onClick={() => { if (v.localScreenshare) void disableScreenshare(); else void enableScreenshare(); }} />
      <button
        className="vsc-btn disconnect"
        title={t("voice.disconnectFromVoice")}
        // Out of fullscreen first: the stage is about to unmount, and a fullscreen element
        // that disappears can leave some browsers on a black screen until Escape.
        onClick={() => { if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => {}); leaveVoiceNow(); }}
      >
        <Icon name="phone-down" size={18} /> {t("voice.disconnect")}
      </button>
    </div>
  );
}

function VideoBox(
  { label, stream, fill, contain, mirror, expandable, overlay }:
  { label: string; stream: MediaStream; fill?: boolean; contain?: boolean; mirror?: boolean; expandable?: boolean; overlay?: React.ReactNode },
) {
  const ref = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  // In fullscreen the controls sit on the picture, so they step aside once the pointer rests.
  const [chrome, setChrome] = useState(true);
  const chromeTimer = useRef<number | undefined>(undefined);
  const wake = (): void => {
    setChrome(true);
    window.clearTimeout(chromeTimer.current);
    chromeTimer.current = window.setTimeout(() => setChrome(false), 2500);
  };
  useEffect(() => () => window.clearTimeout(chromeTimer.current), []);
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
    const onChange = () => {
      const on = document.fullscreenElement === boxRef.current;
      setFull(on);
      if (on) wake();
    };
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
      className={"vstage-video" + (fill ? " fill" : "") + (expandable === true ? " expandable" : "") + (full && !chrome ? " chrome-off" : "")}
      onDoubleClick={expandable === true ? toggleFull : undefined}
      onMouseMove={full ? wake : undefined}
      onTouchStart={full ? wake : undefined}
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
      {full && overlay}
    </div>
  );
}
