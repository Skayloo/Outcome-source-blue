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
import { VoiceCtl } from "@components/VoiceCtl";
import { createLogger } from "@lib/logger";
import { t } from "@lib/i18n";
import { createRNNoiseProcessor, MIN_DENOISE_RATE, micInputRate, handBackToBrowser } from "@lib/noise-suppression";
import { createDeepFilterProcessor, deepFilterWarmed, prefetchDeepFilter, supportsDeepFilter } from "@lib/noise-suppression-dfn";
import { AudioPipeline, micCaptureOptions } from "@lib/audioPipeline";

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
async function attachNoiseSuppressor(room: Room, rebuild: () => void, pipeline: AudioPipeline): Promise<void> {
  const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (mic?.track === undefined) {
    log.warn("no microphone track to filter — guest is listening only");
    return;
  }

  // Already filtered — leave it alone. LiveKit's `stopMicTrackOnMute` defaults to FALSE, so
  // muting keeps the track and its processor alive; the old code here believed a fresh track
  // came back on unmute and rebuilt the filter every time. Rebuilding means instantiating 16 MB
  // of DeepFilterNet wasm again, at the exact moment somebody wants to speak, which is what
  // put three "processor created" lines in a sixteen-second console.
  if (mic.track.getProcessor() !== undefined) return;

  // Same band check as the app: a headset on the hands-free profile gives 8-16 kHz, and both
  // of our models are 48 kHz designs. The guest page turns the browser's suppressor off in
  // its capture defaults, so leaving early here has to turn it back on.
  const mediaTrack = mic.track.mediaStreamTrack;
  log.info("microphone input", mediaTrack.getSettings());
  const rate = micInputRate(mediaTrack);
  if (rate !== null && rate < MIN_DENOISE_RATE) {
    log.warn("narrowband microphone — leaving suppression to the browser", { rate });
    await handBackToBrowser(mediaTrack, `input at ${rate} Hz`);
    return;
  }

  // Loudness FIRST, model second. The denoiser judges what it is given, and given a raw quiet
  // microphone it judges the voice to be noise — so the levelling has to happen before it sees
  // anything. LiveKit's replaceTrack is the seam: publish the normalised track, then attach
  // the processor on top of it.
  const levelled = pipeline.installPreGain(mediaTrack);
  if (levelled !== null) {
    try {
      await mic.track.replaceTrack(levelled);
      log.info("publishing the normalised microphone");
    } catch (err) {
      // Keep the raw track rather than lose audio over a failed swap.
      log.warn("could not publish the normalised track — staying on the raw one", err);
    }
  }

  const warmed = deepFilterWarmed();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setProcessor's generic is wider than the audio processor it accepts at runtime
    await mic.track.setProcessor((warmed ? createDeepFilterProcessor() : createRNNoiseProcessor()) as any);
    log.info("noise suppressor attached", { engine: warmed ? "deepfilter" : "rnnoise" });
  } catch (err) {
    // Our filter owns the signal only while it is actually running. Hand the microphone back
    // to the browser's own suppressor rather than leaving the guest with no suppression at
    // all — which is strictly worse than never having tried.
    log.error("no noise suppression at all — the filter failed to attach", err);
    await handBackToBrowser(mediaTrack, "attach failed");
    return;
  }

  // If the model was not ready, upgrade as soon as it lands. It matters more here than
  // anywhere: a guest clicked a link once, so "the strong filter from your next call" may mean
  // never. Waiting a few seconds into this one is the only chance they get.
  //
  // The comment here used to say this page has no audio pipeline and so could swap freely.
  // That stopped being true when the pipeline was added: a swap replaces the track its source
  // node reads, leaving the graph wired to one nothing flows through — silence, permanently,
  // not for a few seconds. So the upgrade now rebuilds the pipeline after the swap, which is
  // cheap because the context underneath is shared and stays awake.
  if (!warmed && supportsDeepFilter()) void upgradeGuest(room, rebuild);
}

async function upgradeGuest(room: Room, rebuild: () => void): Promise<void> {
  try {
    await prefetchDeepFilter();
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (mic?.track === undefined) return; // call ended while the model was coming down
    await mic.track.stopProcessor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same wide generic as above
    await mic.track.setProcessor(createDeepFilterProcessor() as any);
    // The track the graph was reading is gone with the old processor; rebuild onto the new one.
    rebuild();
    log.info("upgraded to DeepFilterNet mid-call");
  } catch (err) {
    log.warn("DeepFilterNet upgrade failed — staying on RNNoise", err);
  }
}

/**
 * Register a one-shot document listener that unlocks audio on the next interaction.
 *
 * Idempotent by construction: the listener removes itself, and re-arming while one is already
 * waiting would only add a second that does the same thing.
 */
let guestUnlockArmed = false;
function armGuestAudioUnlock(room: Room): void {
  if (guestUnlockArmed) return;
  guestUnlockArmed = true;
  const unlock = (): void => {
    guestUnlockArmed = false;
    for (const e of ["pointerdown", "keydown", "touchstart"]) document.removeEventListener(e, unlock);
    void room.startAudio().catch(() => { /* the visible button is still there */ });
  };
  for (const e of ["pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(e, unlock, { passive: true });
  }
  log.warn("audio playback blocked — unlocking on the next interaction");
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
  // Joins muted, like every other conference tool: a guest clicking a link has no idea what
  // their microphone is about to broadcast, and twenty live microphones is what a call sounds
  // like when it fails. The camera starts off for the same reason.
  const [muted, setMuted] = useState(true);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  // Start the 24 MB filter downloading the moment the page opens, not after the guest is
  // already talking. It used to begin inside the room: RNNoise carried the call while
  // DeepFilterNet came down, so a guest spent the first minute — sometimes the whole call —
  // on the weak filter, which is what "the noise suppressor does nothing" was. The name
  // field, the microphone prompt and the join click are dead time the download can have.
  useEffect(() => {
    if (supportsDeepFilter()) void prefetchDeepFilter();
  }, []);

  const roomRef = useRef<Room | null>(null);
  const workerRef = useRef<Worker | null>(null);
  /**
   * The same pipeline the signed-in client runs, on the same class.
   *
   * The guest page used to stop at the denoiser: no make-up gain, no compressor, no
   * transmission gate. That is why it kept the browser's AGC on — there was nothing else to
   * bring the loudness back — and AGC sits BEFORE the model, lifting the room's floor and
   * giving the denoiser a moving target. Two problems that only look separate. Handing guests
   * the whole chain fixes both, and it is the chain the app has been running for weeks.
   */
  const pipelineRef = useRef<AudioPipeline>(new AudioPipeline());
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
    const pipeline = pipelineRef.current;
    return () => {
      pipeline.teardownAudioPipeline();
      pipeline.setRoom(null);
      // The graph goes with the pipeline; the context outlives it and has to be closed here,
      // or the page leaves an audio device open behind it.
      pipeline.closeContext();
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

      // Before the Room, and inside the click that started this: the context created here is
      // the one LiveKit hands to the noise suppressor, and one created any later is a context
      // Firefox and Safari will not start. Three separate contexts is what made a guest silent
      // on Firefox while the same call was fine on Chrome.
      pipelineRef.current.primeContext();
      const sharedAudioContext = pipelineRef.current.context;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        // Identical to the signed-in client, deliberately: the browser's suppressor would gate
        // the audio before ours sees it, and its AGC runs BEFORE our filter, lifting and
        // dropping the room's floor between words — the hardest case for a denoiser. AGC can
        // be off here now because the pipeline below restores the loudness after the model,
        // which is the only place it can be done without moving the floor the model reads.
        audioCaptureDefaults: micCaptureOptions(),
        // The room shares the page's context rather than making its own. LiveKit documents
        // this option as being for exactly this — "enables audio mixing via the Web Audio API
        // to bypass autoplay restrictions" — and the signed-in client has had it all along,
        // which is why logged-in users never saw the browser difference guests did.
        ...(sharedAudioContext ? { webAudioMix: { audioContext: sharedAudioContext } } : {}),
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
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          const blocked = !room.canPlaybackAudio;
          setAudioBlocked(blocked);
          // The same automatic unlock the signed-in client has had all along, and the reason
          // logged-in users never saw the gap guests did: a click ANYWHERE calls startAudio,
          // which is what wakes the context the noise suppressor runs in. The button below
          // stays for phones, where a visitor may never click anything at all — but nobody
          // should have to find it to be heard.
          if (blocked) armGuestAudioUnlock(room);
        })
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
      // No microphone at join: the guest arrives muted and publishes on their first unmute,
      // which is also where the filter goes on. This is why the permission prompt no longer
      // fires the instant the page connects — nothing is captured until they ask for it.
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
    // Synchronously, before the first await: this call IS the gesture, and Firefox and Safari
    // will only start an AudioContext while one is being handled. Everything below runs in
    // promise continuations, where that permission is already gone.
    if (!next) {
      pipelineRef.current.setRoom(room);
      pipelineRef.current.primeContext();
    }
    void room.localParticipant.setMicrophoneEnabled(!next)
      // First unmute is where the microphone is actually captured, so it is also where the
      // filter goes on. Later unmutes find it already there and leave it alone.
      .then(() => (next ? Promise.resolve()
        : attachNoiseSuppressor(room, () => pipelineRef.current.setupAudioPipeline(),
            pipelineRef.current)))
      .then(() => {
        // After the suppressor, never before: the pipeline taps the track the processor
        // produced, and building it first would leave it wired to the raw one. The context it
        // uses was already created above, while the click was still in hand.
        if (!next) pipelineRef.current.setupAudioPipeline();
      })
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
    // Before the room goes: the pipeline holds an AudioContext and a worklet, and leaving them
    // running keeps the microphone open on a page that says the call is over.
    pipelineRef.current.teardownAudioPipeline();
    pipelineRef.current.setRoom(null);
    pipelineRef.current.closeContext();
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

            {/* The same controls as the in-app voice bar, from the same component. These were
                `.ac-btn` — the admin toolbar button, whose base state and `.on` state are both
                var(--accent) — so pressing mute swapped the icon and left the button looking
                exactly as it did before. Muted is red, publishing is green, neutral is dark. */}
            <div className="guest-controls">
              <VoiceCtl name={muted ? "mic-off" : "mic"} red={muted}
                label={muted ? t("guest.unmute") : t("guest.mute")} onClick={toggleMute} />
              <VoiceCtl name={camera ? "camera-off" : "camera"} on={camera}
                label={camera ? t("guest.cameraOff") : t("guest.cameraOn")} onClick={toggleCamera} />
              <VoiceCtl name={screen ? "monitor-off" : "monitor"} on={screen}
                label={screen ? t("guest.screenOff") : t("guest.screenOn")} onClick={toggleScreen} />
              <button className="vsc-btn disconnect" title={t("guest.leave")} onClick={leave}>
                <Icon name="phone-down" size={18} /> {t("guest.leave")}
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
