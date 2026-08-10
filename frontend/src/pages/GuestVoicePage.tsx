/**
 * No-login guest entry into one voice channel, reached at /guest/<code>. Standalone by
 * design: no auth store, no app WS, no api client — just two public REST calls and a
 * direct livekit-client Room. The visitor types a display name ("how should we introduce
 * you?"), gets a media token, and lands in the room with mic / camera / screen-share
 * controls. Video (theirs and everyone else's) renders here; only the app-level data
 * channel stays closed to guests.
 */
import { useEffect, useRef, useState } from "react";
import {
  Room, RoomEvent, Track,
  type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant,
  type LocalTrackPublication,
} from "livekit-client";
import { BrandMark, useSpaceBrand } from "@components/BrandMark";
import { Icon } from "@lib/icons";
import { createLogger } from "@lib/logger";
import { t } from "@lib/i18n";
import { createRNNoiseProcessor } from "@lib/noise-suppression";
import { createDeepFilterProcessor, deepFilterWarmed, prefetchDeepFilter, supportsDeepFilter } from "@lib/noise-suppression-dfn";

const log = createLogger("guest-voice");

type Phase = "loading" | "form" | "connecting" | "connected" | "closed" | "invalid";

/**
 * Put the noise suppressor on the microphone.
 *
 * RNNoise goes on first, always: it is already in the bundle, so the guest is audible in the
 * same tick. DeepFilterNet takes over underneath once its 12 MB have landed — a guest who
 * clicked a link should not sit silent waiting for a download, and should not have to find a
 * setting to stop their fan being heard either.
 *
 * Fails soft at every step: no DeepFilterNet leaves RNNoise, no worklet at all leaves the
 * plain microphone. A call with noise beats no call.
 */
async function attachNoiseSuppressor(room: Room): Promise<void> {
  const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (mic?.track === undefined) {
    log.warn("no microphone track to filter — guest is listening only");
    return;
  }

  const warmed = deepFilterWarmed();
  try {
    if (mic.track.getProcessor() !== undefined) await mic.track.stopProcessor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setProcessor's generic is wider than the audio processor it accepts at runtime
    await mic.track.setProcessor((warmed ? createDeepFilterProcessor() : createRNNoiseProcessor()) as any);
    log.info("noise suppressor attached", { engine: warmed ? "deepfilter" : "rnnoise" });
  } catch (err) {
    log.error("no noise suppression at all — the filter failed to attach", err);
    return;
  }

  // If the model was not ready, upgrade as soon as it lands — DO swap here, unlike the app.
  // The app cannot: its audio pipeline owns the sender track, so a second swap leaves the
  // level analyser reading a track nothing flows through. This page has no such pipeline —
  // the processor sits directly on the LiveKit track and nothing else touches it.
  //
  // It matters more here than anywhere: a guest clicked a link once, so "the strong filter
  // from your next call" may mean never. Waiting a few seconds into this one is the only
  // chance they get.
  if (!warmed && supportsDeepFilter()) void upgradeGuest(room);
}

async function upgradeGuest(room: Room): Promise<void> {
  try {
    await prefetchDeepFilter();
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (mic?.track === undefined) return; // call ended while the model was coming down
    await mic.track.stopProcessor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same wide generic as above
    await mic.track.setProcessor(createDeepFilterProcessor() as any);
    log.info("upgraded to DeepFilterNet mid-call");
  } catch (err) {
    log.warn("DeepFilterNet upgrade failed — staying on RNNoise", err);
  }
}

/** iOS or Android — the platforms where the Outcome app can take this link over. */
const isMobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent);

/** One participant tile: a name plus, when they publish video, the stream to show. */
interface Tile {
  id: string;
  name: string;
  speaking: boolean;
  isLocal: boolean;
  muted: boolean;
  camera: MediaStream | null;
  screen: MediaStream | null;
}

/** Attaches a MediaStream to a <video>; muted for the local preview (no self-echo). */
function VideoTile({ stream, mirror, muted }: { stream: MediaStream; mirror?: boolean; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className="guest-video"
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}

export function GuestVoicePage({ code }: { code: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [channelName, setChannelName] = useState("");
  const [serverName, setServerName] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [muted, setMuted] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const audioRef = useRef<HTMLDivElement | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // On a tenant's domain the card wears their logo and name; the channel stays in the subtitle.
  const brand = useSpaceBrand();

  useEffect(() => {
    fetch(`/api/v1/guest/${encodeURIComponent(code)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const d = await r.json();
        setChannelName(d.channel_name);
        setServerName(d.server_name);
        setPhase("form");
      })
      .catch(() => setPhase("invalid"));
    return () => {
      roomRef.current?.disconnect().catch(() => { /* leaving anyway */ });
      void wakeLockRef.current?.release().catch(() => { /* already gone */ });
      wakeLockRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [code]);

  /** Rebuild the tile list from the room's live state — participants and their video tracks. */
  const refreshTiles = (room: Room): void => {
    const speakers = new Set(room.activeSpeakers.map((p) => p.identity));
    // Ignore a MUTED or ENDED video track. Turning a camera off mutes the publication rather
    // than unpublishing it, so the track's last frame stays around — showing it froze the
    // tile on that last frame. Only a live, unmuted track counts as active video.
    const streamOf = (
      pub: { isMuted?: boolean; track?: { mediaStream?: MediaStream; mediaStreamTrack?: MediaStreamTrack } | null } | undefined,
    ): MediaStream | null => {
      if (!pub || pub.isMuted || !pub.track) return null;
      if (pub.track.mediaStreamTrack && pub.track.mediaStreamTrack.readyState !== "live") return null;
      return pub.track.mediaStream ?? null;
    };

    // A participant with NO live mic publication is muted too: members mute by fully
    // unpublishing the track ("nuclear mute"), not by flipping the muted bit.
    const micMuted = (p: { getTrackPublication: (s: Track.Source) => { isMuted?: boolean } | undefined }): boolean => {
      const mic = p.getTrackPublication(Track.Source.Microphone);
      return !mic || mic.isMuted === true;
    };

    const local = room.localParticipant;
    const list: Tile[] = [{
      id: local.identity,
      name: local.name || t("guest.you"),
      speaking: speakers.has(local.identity),
      isLocal: true,
      muted: micMuted(local),
      camera: streamOf(local.getTrackPublication(Track.Source.Camera)),
      screen: streamOf(local.getTrackPublication(Track.Source.ScreenShare)),
    }];
    for (const p of room.remoteParticipants.values()) {
      list.push({
        id: p.identity,
        name: p.name || p.identity,
        speaking: speakers.has(p.identity),
        isLocal: false,
        muted: micMuted(p),
        camera: streamOf(p.getTrackPublication(Track.Source.Camera)),
        screen: streamOf(p.getTrackPublication(Track.Source.ScreenShare)),
      });
    }
    setTiles(list);
  };

  async function join(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    if (name.trim().length < 2) { setError(t("guest.nameTooShort")); return; }
    setPhase("connecting");
    try {
      const r = await fetch(`/api/v1/guest/${encodeURIComponent(code)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: name.trim() }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.message ?? t("guest.joinFailed"));
      }
      const { token } = await r.json();

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        // Ours is the only processing on this signal besides echo cancellation. The browser's
        // suppressor would gate the audio first and leave our model chewing on what survived;
        // its AGC is worse, because it runs BEFORE our filter and keeps lifting and dropping
        // the noise floor between words — a moving target is the hardest case for a denoiser.
        // AGC on: guests have no gain control of their own and nothing downstream to make
        // up the difference, so switching it off simply made every guest quiet. The browser's
        // own suppression stays off — two filters in series is a different problem.
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      });
      roomRef.current = room;
      const rerender = () => refreshTiles(room);
      room
        .on(RoomEvent.ParticipantConnected, rerender)
        .on(RoomEvent.ParticipantDisconnected, rerender)
        .on(RoomEvent.ActiveSpeakersChanged, rerender)
        .on(RoomEvent.LocalTrackPublished, (_pub: LocalTrackPublication) => rerender())
        // Camera on/off mutes/unmutes the track (it isn't unpublished), so we must repaint on
        // mute changes too — otherwise a turned-off camera leaves its frozen last frame.
        .on(RoomEvent.TrackMuted, () => rerender())
        .on(RoomEvent.TrackUnmuted, () => rerender())
        .on(RoomEvent.LocalTrackUnpublished, (_pub: LocalTrackPublication) => rerender())
        .on(RoomEvent.Disconnected, () => setPhase("closed"))
        // A phone will not play incoming audio until the visitor gestures. Without a visible
        // button they never do, and the room simply seems dead.
        .on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!room.canPlaybackAudio))
        .on(RoomEvent.TrackSubscribed,
          (track: RemoteTrack, _pub: RemoteTrackPublication, _p: RemoteParticipant) => {
            // Audio is attached to a hidden sink; video is rendered by the tiles below.
            if (track.kind === Track.Kind.Audio && audioRef.current) {
              audioRef.current.appendChild(track.attach());
            }
            rerender();
          })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach().forEach((el) => el.remove());
          rerender();
        });

      const url = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/livekit`;
      // Bound the connect: a browser that can't do WebRTC (or a blocked media port) leaves
      // room.connect() hanging forever, and the button sat on "Connecting…" with no error and
      // no way back. Fail loudly instead of pretending to work.
      await Promise.race([
        room.connect(url, token),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(t("guest.connectTimeout"))), 20_000)),
      ]);
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        // NOT awaited, ever. A noise filter must never be able to hold up a call: whatever
        // it does — probe a cache, load a model, fail outright — the guest is already
        // connected and the mic is already publishing. It attaches underneath or it does not.
        void attachNoiseSuppressor(room);
      } catch {
        // No mic permission — stay as a listener; the button reflects reality.
        setMuted(true);
      }
      refreshTiles(room);
      setPhase("connected");
      // A locked screen suspends the tab and the microphone with it.
      navigator.wakeLock?.request("screen").then((l) => { wakeLockRef.current = l; }).catch(() => { /* unsupported */ });
      setAudioBlocked(!room.canPlaybackAudio);
    } catch (e) {
      roomRef.current?.disconnect().catch(() => { /* never connected */ });
      roomRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
      setError(e instanceof Error && e.message ? e.message : t("guest.joinFailed"));
      setPhase("form");
    }
  }

  const toggleMute = (): void => {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    setMuted(next);
    void room.localParticipant.setMicrophoneEnabled(!next)
      // Unmuting publishes a fresh track, which carries no processor of its own.
      .then(() => (next ? Promise.resolve() : attachNoiseSuppressor(room)))
      .then(() => refreshTiles(room))
      .catch(() => setMuted(!next));
  };

  const toggleCamera = (): void => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camera;
    void room.localParticipant.setCameraEnabled(next)
      .then(() => { setCamera(next); refreshTiles(room); })
      .catch(() => setError(t("guest.cameraFailed")));
  };

  const toggleScreen = (): void => {
    const room = roomRef.current;
    if (!room) return;
    const next = !screen;
    // audio: true shares tab audio when the browser offers it (Chrome tab-share).
    void room.localParticipant.setScreenShareEnabled(next, { audio: true })
      .then(() => { setScreen(next); refreshTiles(room); })
      .catch(() => setError(t("guest.screenFailed"))); // includes "user cancelled the picker"
  };

  const leave = (): void => {
    roomRef.current?.disconnect().catch(() => { /* leaving anyway */ });
    roomRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    setPhase("closed");
  };

  // Screen shares get the big stage; everyone else is a strip of small tiles.
  const shares = tiles.filter((p) => p.screen !== null);
  const connected = phase === "connected";

  // Tiles are laid out on a grid whose column count follows the number of people, so one
  // guest gets a big tile instead of a lonely thumbnail floating in a wide card, and a
  // crowd stays square-ish instead of a single endless row. With a screen share on stage
  // the tiles step aside into a compact strip.
  const count = tiles.length;
  const cols = shares.length > 0
    ? Math.min(count, 5)
    : Math.min(Math.ceil(Math.sqrt(Math.max(count, 1))), 4);

  return (
    <div className={"guest-page" + (connected ? " in-room" : "")}>
      <div
        className={"guest-card" + (connected ? " wide" : "") + (shares.length > 0 ? " has-stage" : "")}
        style={{ "--tile-cols": cols } as React.CSSProperties}
      >
        <div className="form-logo">
          <BrandMark brand={brand} width={56} />
          <h1>{brand?.name || serverName || "Outcome"}</h1>
          {phase !== "invalid" && <p>{t("guest.subtitle", { channel: channelName })}</p>}
        </div>

        {error && (
          <div className="error-banner visible guest-error" role="alert">
            <span>{error}</span>
            {/* Dismissable: a failed camera (no webcam, or one another app has claimed) must not
                leave a red bar stuck over the room for the rest of the call. */}
            <button className="guest-error-close" aria-label={t("common.close")} onClick={() => setError(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        {phase === "loading" && <div className="guest-hint">{t("guest.loading")}</div>}
        {phase === "invalid" && <div className="guest-hint">{t("guest.invalidLink")}</div>}

        {/* On a phone the app does this better than a browser tab: it keeps the call alive in
            the background and doesn't fight Safari over the microphone. The custom scheme is
            the same one the SSO callback already uses. Nothing happens if the app isn't
            installed — the page stays right here, so this is an offer, not a redirect. */}
        {phase === "form" && isMobile && (
          <a className="guest-app-cta" href={`outcome://guest/${encodeURIComponent(code)}`}>
            <Icon name="external-link" size={16} />
            <span>{t("guest.openInApp")}</span>
          </a>
        )}

        {(phase === "form" || phase === "connecting") && (
          <form className="connect-form" onSubmit={join} noValidate>
            <div className="form-group">
              <label className="form-label" htmlFor="guest-name">{t("guest.nameLabel")}</label>
              <input className="form-input" id="guest-name" autoFocus maxLength={24}
                placeholder={t("guest.namePlaceholder")}
                value={name} onChange={(e) => setName(e.target.value)} />
              <div className="form-hint">{t("guest.nameHint")}</div>
            </div>
            <button className="btn-primary" type="submit" disabled={phase === "connecting"}>
              {phase === "connecting" ? t("guest.connecting") : t("guest.joinBtn")}
            </button>
          </form>
        )}

        {audioBlocked && (
          <button className="vd-unblock" onClick={() => {
            void roomRef.current?.startAudio().then(() => setAudioBlocked(!roomRef.current?.canPlaybackAudio));
          }}>{t("voice.enableSound")}</button>
        )}

        {connected && (
          <>
            {shares.length > 0 && (
              <div className="guest-stage">
                {shares.map((p) => (
                  <div className="guest-stage-item" key={`s-${p.id}`}>
                    <VideoTile stream={p.screen!} muted={p.isLocal} />
                    <span className="guest-stage-label">
                      {t("guest.screenOf", { name: p.name })}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className={"guest-tiles" + (shares.length > 0 ? " strip" : "")}>
              {tiles.map((p) => (
                <div key={p.id} className={"guest-tile" + (p.speaking ? " speaking" : "")}>
                  {p.camera
                    ? <VideoTile stream={p.camera} mirror={p.isLocal} muted={p.isLocal} />
                    : <div className="guest-tile-audio"><Icon name="volume-2" size={14} /></div>}
                  <span className="guest-tile-name">
                    {p.muted && <Icon name="mic-off" size={11} />}
                    {p.name}{p.isLocal ? ` ${t("guest.youSuffix")}` : ""}
                  </span>
                </div>
              ))}
            </div>

            <div className="guest-controls">
              <button className={"ac-btn" + (muted ? " on" : "")} onClick={toggleMute}>
                <Icon name={muted ? "mic-off" : "mic"} size={16} /> {muted ? t("guest.unmute") : t("guest.mute")}
              </button>
              <button className={"ac-btn" + (camera ? " on" : "")} onClick={toggleCamera}>
                <Icon name={camera ? "camera-off" : "camera"} size={16} /> {camera ? t("guest.cameraOff") : t("guest.cameraOn")}
              </button>
              <button className={"ac-btn" + (screen ? " on" : "")} onClick={toggleScreen}>
                <Icon name={screen ? "monitor-off" : "monitor"} size={16} /> {screen ? t("guest.screenOff") : t("guest.screenOn")}
              </button>
              <button className="ac-btn account-delete-btn" onClick={leave}>
                <Icon name="phone-down" size={16} /> {t("guest.leave")}
              </button>
            </div>
          </>
        )}

        {phase === "closed" && (
          <div className="guest-hint">
            {t("guest.left")}{" "}
            <button className="form-toggle-action" onClick={() => { setTiles([]); setPhase("form"); }}>
              {t("guest.rejoin")}
            </button>
          </div>
        )}

        <div ref={audioRef} style={{ display: "none" }} />
      </div>
    </div>
  );
}
