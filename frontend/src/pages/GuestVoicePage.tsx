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
import { FloatingReactions, VoiceFxControls, useReactionFeed } from "@components/VoiceFx";
import { describeMediaError } from "@lib/mediaErrors";
import { onReaction, raisedHands, sendReaction, setHandRaised, type Reaction } from "@lib/voiceReactions";
import { createLogger } from "@lib/logger";
import { t } from "@lib/i18n";
import { createRNNoiseProcessor, MIN_DENOISE_RATE, micInputRate, handBackToBrowser } from "@lib/noise-suppression";
import { AudioPipeline, micCaptureOptions } from "@lib/audioPipeline";
import { nextNormGain } from "@lib/loudnessNorm";

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

  // No levelling stage in front of the model any more. It was here because the browser's AGC
  // had been turned off and Firefox handed over a raw, near-inaudible microphone — but the AGC
  // is on again, it does the coarse lift where WebRTC intends it to, and a second regulator on
  // the same signal is what every one of these bugs has turned out to be.

  try {
    // RNNoise, and only RNNoise. It is what Jitsi ships in a worklet — a few hundred kilobytes
    // against DeepFilterNet's 24 MB — and a guest who clicked a link once should not spend the
    // first minute of the call downloading a model. The swap to the heavier filter mid-call
    // used to live here and was its own source of silence: replacing the track under a running
    // graph leaves the graph reading one nothing flows through.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setProcessor's generic is wider than the audio processor it accepts at runtime
    await mic.track.setProcessor(createRNNoiseProcessor() as any);
    log.info("noise suppressor attached", { engine: "rnnoise" });
  } catch (err) {
    // Our filter owns the signal only while it is actually running. Hand the microphone back
    // to the browser's own suppressor rather than leaving the guest with no suppression at
    // all — which is strictly worse than never having tried.
    log.error("no noise suppression at all — the filter failed to attach", err);
    await handBackToBrowser(mediaTrack, "attach failed");
    return;
  }
  rebuild();
}


/**
 * Register a one-shot document listener that unlocks audio on the next interaction.
 *
 * Idempotent by construction: the listener removes itself, and re-arming while one is already
 * waiting would only add a second that does the same thing.
 */
/** The microphone a returning guest picked last time. Their own browser, their own choice —
 *  it never leaves the device. */
const GUEST_MIC_KEY = "outcome:guest:micId";

/** The page's AudioContext, once the join has one. Module-level because the unlock handlers
 *  below live out here too, and they need to know whether the Web Audio graph — rather than
 *  the <audio> elements — is what the room is being heard through. */
let guestSharedCtx: AudioContext | null = null;

/**
 * Receive-side loudness levelling for the guest page.
 *
 * The signed-in client got this and the guest page did not — and the guest page is where the
 * dailies actually happen, so "still a bit floaty" was measured on the one path without it.
 * Same arithmetic, same bounds, same reason it belongs here and not on the sender: the browser
 * already regulates there, and a second regulator racing it is the whole bug we just removed.
 */
const guestTaps = new Map<string, { p: RemoteParticipant; an: AnalyserNode; src: MediaStreamAudioSourceNode; buf: Float32Array<ArrayBuffer>; gain: number }>();
let guestNormTimer: ReturnType<typeof setInterval> | null = null;

function guestTapLevel(participant: RemoteParticipant, track: RemoteTrack): void {
  const ctx = guestSharedCtx;
  if (ctx === null || guestTaps.has(participant.identity)) return;
  try {
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    const src = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    src.connect(an); // a reading, not a stage
    guestTaps.set(participant.identity, {
      p: participant, an, src, buf: new Float32Array(new ArrayBuffer(an.fftSize * 4)), gain: 1,
    });
    guestNormTimer ??= setInterval(() => {
      for (const tap of guestTaps.values()) {
        tap.an.getFloatTimeDomainData(tap.buf);
        let sum = 0;
        for (const v of tap.buf) sum += v * v;
        const next = nextNormGain(tap.gain, Math.sqrt(sum / tap.buf.length));
        if (Math.abs(next - tap.gain) < 1e-4) continue;
        tap.gain = next;
        tap.p.setVolume(next);
      }
    }, 400);
  } catch (err) {
    log.debug("could not tap remote level", err);
  }
}

/** The guest half of __outcome.voiceReport(): that one reads the signed-in session, which on
 *  this page is empty. Same question, same paste, different room. */
function installGuestReport(room: Room, pipeline: AudioPipeline): void {
  const ns = ((window as unknown as Record<string, unknown>).__outcome ??= {}) as Record<string, unknown>;
  ns.voiceReport = (): Record<string, unknown> => {
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const settings = mic?.track?.mediaStreamTrack.getSettings() as Record<string, unknown> | undefined;
    return {
      page: "guest",
      browser: navigator.userAgent,
      room: room.name,
      state: room.state,
      mic: {
        muted: mic?.isMuted ?? null,
        engine: pipeline.activeEngine,
        applied: settings === undefined ? null : {
          deviceId: settings.deviceId, sampleRate: settings.sampleRate,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
          voiceIsolation: settings.voiceIsolation,
        },
        publishedRms: pipeline.readPublishedRms(),
      },
      audio: { contextState: pipeline.ctxState, canPlayback: room.canPlaybackAudio },
      speakers: [...guestTaps.entries()].map(([identity, tap]) => {
        tap.an.getFloatTimeDomainData(tap.buf);
        let sum = 0;
        for (const v of tap.buf) sum += v * v;
        return { identity, rms: Math.sqrt(sum / tap.buf.length), norm: tap.gain };
      }),
    };
  };
}

function guestDropTap(identity: string): void {
  const tap = guestTaps.get(identity);
  if (tap === undefined) return;
  tap.src.disconnect();
  tap.an.disconnect();
  guestTaps.delete(identity);
  if (guestTaps.size === 0 && guestNormTimer !== null) {
    clearInterval(guestNormTimer);
    guestNormTimer = null;
  }
}

let guestUnlockArmed = false;
/** Set once room.startAudio() has RESOLVED. canPlaybackAudio is NOT that: with webAudioMix
 *  LiveKit recomputes it from the AudioContext state, so a play() the browser refused still
 *  reports "allowed" a moment later — and the tab stays mute with nothing armed to ask again.
 *  Same trap as livekitSession.audioStarted; both sides learned it the same evening. */
let guestAudioStarted = false;
/** The same doubling trap the signed-in client has — see AudioElements.silenceDoubledElements.
 *  Safari hands the AudioContext over only after a gesture, so the elements attached before
 *  that keep playing alongside the graph and every voice arrives twice. */
function silenceDoubledGuestAudio(): void {
  if (guestSharedCtx === null) return;
  for (const el of document.querySelectorAll("audio")) {
    // LiveKit's iOS workaround plays an empty track on purpose; muting it breaks the very
    // thing it is there for.
    if (el.id === "livekit-dummy-audio-el" || el.muted) continue;
    el.muted = true;
    el.volume = 0;
  }
}

function armGuestAudioUnlock(room: Room): void {
  if (guestUnlockArmed) return;
  guestUnlockArmed = true;
  const unlock = (): void => {
    guestUnlockArmed = false;
    for (const e of ["pointerdown", "keydown", "touchstart"]) document.removeEventListener(e, unlock);
    void room.startAudio()
      .then(() => { guestAudioStarted = true; silenceDoubledGuestAudio(); })
      // Refused: this gesture was not one the browser accepts. Wait for the next rather than
      // leaving the visitor with a room that looks connected and plays nothing.
      .catch(() => armGuestAudioUnlock(room));
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
  // Which microphone to publish with. A laptop with a webcam, a headset and a monitor all
  // report a microphone, the browser picks whichever it calls "default", and until now the
  // guest page had no way to disagree — the signed-in client has had a picker all along.
  const [mics, setMics] = useState<Array<{ id: string; label: string }>>([]);
  /** Written to directly rather than through state: this moves twenty times a second, and a
   *  React render per frame to animate one bar is how a join screen starts dropping frames. */
  const meterRef = useRef<HTMLDivElement>(null);
  /** Whether the browser actually handed over a microphone on this screen. "denied" is the
   *  state that used to be invisible: no labels, no device list, a bar that never moves, and
   *  nothing on screen saying why. */
  const [micProbe, setMicProbe] = useState<"pending" | "ok" | "denied">("pending");
  const [micId, setMicId] = useState<string>(() => {
    try { return localStorage.getItem(GUEST_MIC_KEY) ?? ""; } catch { return ""; }
  });
  const [error, setError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  /** Raised hands by participant identity — LiveKit attributes, so a hand raised before we
   *  joined is already there and one whose owner leaves takes itself down. */
  const [hands, setHands] = useState<ReadonlyMap<string, number>>(new Map());
  const reactions = useReactionFeed<string>(
    (cb) => (roomRef.current === null ? () => { /* not connected */ } : onReaction(roomRef.current, cb)),
    [phase],
  );
  // Joins muted, like every other conference tool: a guest clicking a link has no idea what
  // their microphone is about to broadcast, and twenty live microphones is what a call sounds
  // like when it fails. The camera starts off for the same reason.
  const [muted, setMuted] = useState(true);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
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
    setHands(raisedHands(room));
  };

  // Fill the picker while the guest is still deciding to join. Two things happen here, and
  // the second matters more: device LABELS stay empty until the page has held a microphone
  // once, so we take one briefly — which also puts the browser's permission prompt on THIS
  // screen. Refused here, the guest finds out now, not two minutes later in a room full of
  // people where the unmute button just flips back and says nothing.
  useEffect(() => {
    if (phase !== "form") return;
    let cancelled = false;
    let probe: MediaStream | null = null;
    const stopProbe = (): void => { probe?.getTracks().forEach((tr) => tr.stop()); probe = null; };
    const list = (): void => {
      void navigator.mediaDevices?.enumerateDevices().then((devices) => {
        if (cancelled) return;
        setMics(devices
          // "default" and "communications" are the browser's own aliases for a real device
          // further down the list; our first option already means "whatever the system picks".
          .filter((d) => d.kind === "audioinput"
            && d.deviceId !== "default" && d.deviceId !== "communications" && d.deviceId !== "")
          .map((d) => ({
            id: d.deviceId,
            label: d.label || t("settings.deviceMicrophone", { id: d.deviceId.slice(0, 8) }),
          })));
      }).catch(() => { /* enumeration unavailable — the picker stays on the default */ });
    };
    let raf = 0;
    const meter = (an: AnalyserNode): void => {
      const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
      const tick = (): void => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        // Square root, not the raw value: loudness is not linear, and a bar that only twitches
        // when you shout tells the guest their microphone is broken when it is fine.
        const pct = Math.min(100, Math.round(Math.sqrt(rms) * 180));
        if (meterRef.current !== null) meterRef.current.style.width = `${pct}%`;
        raf = requestAnimationFrame(tick);
      };
      tick();
    };
    void (async () => {
      try {
        probe = await navigator.mediaDevices.getUserMedia(
          micId ? { audio: { deviceId: { exact: micId } } } : { audio: true });
        if (!cancelled) setMicProbe("ok");
      } catch {
        // Refused, or no microphone at all. Say so HERE — this is the screen where it can
        // still be fixed, and a dead level bar with no explanation is what a broken app looks
        // like. Without permission the browser also hands back devices with empty ids, which
        // is why the picker would otherwise silently not be there either.
        if (!cancelled) setMicProbe("denied");
      }
      if (cancelled) { stopProbe(); return; }
      list();
      // The stream stays open while this screen is up, on purpose: it drives the level bar, so
      // a guest can see their own voice move BEFORE joining. Every conference tool shows the
      // recording indicator on its pre-join screen for exactly this reason.
      if (probe !== null) {
        pipelineRef.current.primeContext();
        const ctx = pipelineRef.current.context;
        if (ctx !== null) {
          const an = ctx.createAnalyser();
          an.fftSize = 1024;
          ctx.createMediaStreamSource(probe).connect(an);
          meter(an);
        }
      }
      navigator.mediaDevices?.addEventListener("devicechange", list);
    })();
    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      stopProbe();
      navigator.mediaDevices?.removeEventListener("devicechange", list);
    };
  }, [phase, micId]);

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
      guestSharedCtx = sharedAudioContext;
      guestAudioStarted = false; // fresh room, fresh elements: nothing has played yet
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        // Identical to the signed-in client, deliberately: the browser's suppressor would gate
        // the audio before ours sees it, and its AGC runs BEFORE our filter, lifting and
        // dropping the room's floor between words — the hardest case for a denoiser. AGC can
        // be off here now because the pipeline below restores the loudness after the model,
        // which is the only place it can be done without moving the floor the model reads.
        // ...plus the device the guest chose on the way in. Empty means "let the browser
        // decide", which is what it did on its own before this picker existed.
        audioCaptureDefaults: { ...micCaptureOptions(), ...(micId ? { deviceId: micId } : {}) },
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
        .on(RoomEvent.Disconnected, () => {
          for (const identity of [...guestTaps.keys()]) guestDropTap(identity);
          setPhase("closed");
        })
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
          if (blocked || !guestAudioStarted) armGuestAudioUnlock(room);
        })
        .on(RoomEvent.ParticipantAttributesChanged, () => refreshTiles(room))
        .on(RoomEvent.TrackSubscribed,
          (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
            // Audio is attached to a hidden sink; video is rendered by the tiles below.
            if (track.kind === Track.Kind.Audio && audioRef.current) {
              audioRef.current.appendChild(track.attach());
              guestTapLevel(p, track);
            }
            rerender();
          })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
          track.detach().forEach((el) => el.remove());
          guestDropTap(p.identity);
          rerender();
        });

      installGuestReport(room, pipelineRef.current);

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
      .catch((err: unknown) => {
        setMuted(!next);
        // Saying nothing here is what made this look like a dead button: the toggle flipped
        // back, the room carried on, and the guest pressed it again. The camera path next to
        // it has always explained itself. A microphone the browser refuses is by far the most
        // common reason, and it is not something the page can fix for them — so name it.
        const denied = err instanceof DOMException
          && (err.name === "NotAllowedError" || err.name === "SecurityError");
        setError(t(denied ? "guest.micBlocked" : "guest.micFailed"));
      });
  };

  const toggleCamera = (): void => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camera;
    void room.localParticipant.setCameraEnabled(next)
      .then(() => { setCamera(next); refreshTiles(room); })
      // The browser knows WHY — a refused permission, a camera another app is holding, a
      // camera switched off in the system are three different problems with three different
      // fixes. Throwing that away and saying "could not turn the camera on" cost an evening.
      .catch((err: unknown) => setError(describeMediaError(err, "camera")));
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
          <form
            className="connect-form" onSubmit={join} noValidate
            // Firefox and Safari hand over a running AudioContext only while a gesture is being
            // handled, and typing a name is the first one this screen gets.
            onPointerDown={() => pipelineRef.current.primeContext()}
            onKeyDown={() => pipelineRef.current.primeContext()}
          >
            <div className="form-group">
              <label className="form-label" htmlFor="guest-name">{t("guest.nameLabel")}</label>
              <input className="form-input" id="guest-name" autoFocus maxLength={24}
                placeholder={t("guest.namePlaceholder")}
                value={name} onChange={(e) => setName(e.target.value)} />
              <div className="form-hint">{t("guest.nameHint")}</div>
            </div>
            {micProbe !== "denied" && (
              <div className="form-group">
                <label className="form-label" htmlFor="guest-mic">{t("guest.micLabel")}</label>
                <select
                  className="form-input" id="guest-mic" value={micId}
                  onChange={(ev) => {
                    setMicId(ev.target.value);
                    try { localStorage.setItem(GUEST_MIC_KEY, ev.target.value); } catch { /* private mode */ }
                  }}
                >
                  <option value="">{t("guest.micDefault")}</option>
                  {mics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
            )}
            {/* Not behind the picker's condition: someone with one microphone needs the check
                more than someone with three, not less. */}
            <div className="form-group">
              <div className="form-hint">
                {micProbe === "denied" ? t("guest.micBlocked") : t("guest.micCheck")}
              </div>
              {micProbe !== "denied" && (
                <div style={{ height: 6, borderRadius: 3, background: "rgba(127,127,127,.22)", overflow: "hidden" }}>
                  <div ref={meterRef} style={{ height: "100%", width: "0%", borderRadius: 3, background: "currentColor", opacity: .75 }} />
                </div>
              )}
            </div>
            <button className="btn-primary" type="submit" disabled={phase === "connecting"}>
              {phase === "connecting" ? t("guest.connecting") : t("guest.joinBtn")}
            </button>
          </form>
        )}

        {audioBlocked && (
          <button className="vd-unblock" onClick={() => {
            void roomRef.current?.startAudio().then(() => {
              guestAudioStarted = true;
              silenceDoubledGuestAudio();
              setAudioBlocked(false);
            });
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
                  <FloatingReactions items={reactions.get(p.id) ?? []} />
                  {hands.has(p.id) && <span className="vstage-hand" title={t("voice.handRaised")}>✋</span>}
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
              {/* Same grammar as the microphone next to it: the ICON is the STATE, not the
                  action. Crossed out and red means they cannot see you; plain and green means
                  you are on camera. It read backwards before — a plain camera icon while the
                  camera was off, and the crossed-out one only once you turned it ON. */}
              <VoiceCtl name={camera ? "camera" : "camera-off"} on={camera} red={!camera}
                label={camera ? t("guest.cameraOff") : t("guest.cameraOn")} onClick={toggleCamera} />
              <VoiceCtl name={screen ? "monitor-off" : "monitor"} on={screen}
                label={screen ? t("guest.screenOff") : t("guest.screenOn")} onClick={toggleScreen} />
              <VoiceFxControls
                handUp={roomRef.current !== null && hands.has(roomRef.current.localParticipant.identity)}
                onHand={(up) => {
                  const room = roomRef.current;
                  if (room === null) return;
                  void setHandRaised(room, up).then(() => setHands(raisedHands(room)));
                }}
                onReact={(emoji: Reaction) => {
                  if (roomRef.current !== null) void sendReaction(roomRef.current, emoji);
                }}
              />
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
