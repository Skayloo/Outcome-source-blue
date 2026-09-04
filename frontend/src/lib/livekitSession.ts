// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  ScreenSharePresets,
  createLocalScreenTracks,
  createLocalVideoTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublication,
  type Participant as LKParticipant,
  type RemoteParticipant,
  type Participant,
  type LocalVideoTrack,
  type LocalTrack,
  type LocalTrackPublication,
  type VideoCaptureOptions,
  type ScreenShareCaptureOptions,
  DisconnectReason,
} from "livekit-client";
import { runtimeLivekitUrl } from "@lib/runtimeConfig";
import { serverOrigin } from "@lib/serverHost";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setLocalScreenshare,
  setSpeakers,
  leaveVoiceChannel,
  setListenOnly,
  updateVoiceState,
  removeVoiceUser,
  setConnQuality,
  setVoiceTransport,
  setAudioBlocked,
  setAudioSmoothed,
} from "@stores/voice.store";
import { loadPref } from "@components/settings/helpers";
import { showToast } from "@stores/ui.store";
import { t } from "@lib/i18n";
import { createLogger } from "@lib/logger";
import { micCaptureOptions, AudioPipeline } from "@lib/audioPipeline";
import { AudioElements } from "@lib/audioElements";
import { DeviceManager } from "@lib/deviceManager";

/** The fields of an ICE candidate stat we actually read. */
interface IceCandidateStats { candidateType?: string; protocol?: string; relayProtocol?: string }

const log = createLogger("livekitSession");

// --- Stream quality presets ---

export type StreamQuality = "low" | "medium" | "high" | "source";

const CAMERA_PRESETS: Record<StreamQuality, VideoCaptureOptions> = {
  low:    { resolution: VideoPresets.h360.resolution },
  medium: { resolution: VideoPresets.h720.resolution },
  high:   { resolution: VideoPresets.h1080.resolution },
  source: { resolution: VideoPresets.h1080.resolution },
};

const CAMERA_PUBLISH_BITRATES: Record<StreamQuality, number> = {
  low:    600_000,
  medium: 1_700_000,
  high:   4_000_000,
  source: 8_000_000,
};

const SCREENSHARE_PRESETS: Record<StreamQuality, ScreenShareCaptureOptions> = {
  low:    { audio: true, resolution: ScreenSharePresets.h720fps5.resolution },
  medium: { audio: true, resolution: ScreenSharePresets.h1080fps15.resolution, contentHint: "detail" },
  high:   { audio: true, resolution: ScreenSharePresets.h1080fps30.resolution, contentHint: "detail" },
  source: { audio: true, contentHint: "detail" },  // no resolution cap — use native source resolution
};

const SCREENSHARE_PUBLISH_BITRATES: Record<StreamQuality, number> = {
  low:    1_500_000,
  medium: 3_000_000,
  high:   6_000_000,
  source: 10_000_000,
};

function getStreamQuality(): StreamQuality {
  const saved = loadPref<string>("streamQuality", "high");
  if (saved === "low" || saved === "medium" || saved === "high" || saved === "source") return saved;
  return "high";
}

// --- Pure helpers (no instance state) ---

/** Parse userId from LiveKit participant identity "user-{id}" or "user-{id}.{session}".
 *  The session suffix keeps one account's devices distinct inside a room; the user id is
 *  the same for all of them. Returns 0 if unparseable. */
export function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)(?:\.|$)/);
  if (match !== null && match[1] !== undefined) return parseInt(match[1], 10);
  // Guests have no account id. Give them a STABLE NEGATIVE one derived from their nonce, so
  // members' rosters and video maps (keyed by number) can hold them without ever colliding
  // with a real user id (always positive; 0 is "unknown / system").
  const guest = identity.match(/^guest-([0-9a-f]+)$/i);
  if (guest !== null && guest[1] !== undefined) {
    let h = 0;
    for (const c of guest[1]) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return -(Math.abs(h) || 1);
  }
  return 0;
}

// --- Types ---

type RemoteVideoCallback = (userId: number, stream: MediaStream, isScreenshare: boolean) => void;
type RemoteVideoRemovedCallback = (userId: number, isScreenshare: boolean) => void;
type PendingVoiceJoin = {
  readonly token: string;
  readonly url: string;
  readonly channelId: number;
  readonly directUrl?: string;
};

// --- LiveKitSession class ---

export class LiveKitSession {
  private room: Room | null = null;
  private ws: WsClient | null = null;
  private onErrorCallback: ((message: string) => void) | null = null;
  private currentChannelId: number | null = null;
  private serverHost: string | null = null;
  private onRemoteVideoCallback: RemoteVideoCallback | null = null;
  private onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest token received from server (used for reconnection after token refresh). */
  private latestToken: string | null = null;
  /** Guard: true while handleVoiceToken is connecting — prevents concurrent joins. */
  private connecting = false;
  /** Latest join request received while a connection attempt is already running. */
  private pendingJoin: PendingVoiceJoin | null = null;
  /** Last known LiveKit URL and directUrl for auto-reconnect on unexpected disconnect. */
  private lastUrl: string | null = null;
  private lastDirectUrl: string | undefined = undefined;
  /** Max auto-reconnect attempts before giving up and showing error. */
  private static readonly MAX_RECONNECT_ATTEMPTS = 2;
  private static readonly RECONNECT_DELAY_MS = 3000;
  /** Aborted by leaveVoice() to cancel a pending auto-reconnect loop. */
  private reconnectAc: AbortController | null = null;
  /** Master output volume multiplier (0-2.0). Per-user volumes are scaled by this. */
  private outputVolumeMultiplier = loadPref<number>("outputVolume", 100) / 100;
  // Remote mic + screenshare audio elements are now managed by _audioElements module.
  /** Cached port for the local LiveKit TLS proxy (Rust-side, for self-signed cert support). */
  private liveKitProxyPort: number | null = null;

  // Screenshare mute state is now managed by _audioElements module.

  // --- Extracted modules (facade pattern) ---
  private _audioPipeline = new AudioPipeline();

  get audioPipeline(): AudioPipeline { return this._audioPipeline; }
  private _audioElements = new AudioElements();
  private _deviceManager = new DeviceManager();

  /** Manually published local tracks (camera/screenshare) for explicit cleanup. */
  private manualCameraTrack: LocalVideoTrack | null = null;
  private manualScreenTracks: LocalTrack[] = [];
  /** Local screenshare video wrapped for self-preview (LiveKit doesn't loop your own track back). */
  private localScreenStream: MediaStream | null = null;

  // --- Room factory ---

  private createRoom(): Room {
    // Not every join arrives from a click: a reload that rejoins the channel, a channel move
    // the server pushed, a reconnect that rebuilds the room. joinVoice() primes the context,
    // those paths do not — and a room built without one falls back to a context LiveKit makes
    // itself, which we hold no reference to and can never resume. Its remote audio then mixes
    // into a stopped graph while the speaking indicator, computed by the SFU, keeps blinking:
    // the caller sees a talking head and hears nothing. Prime here so the room always gets OURS.
    this._audioPipeline.primeContext();
    this.audioStarted = false;
    const quality = getStreamQuality();
    const isSource = quality === "source";
    const newRoom = new Room({
      // Route remote audio through a shared Web Audio graph so per-participant/output volume can
      // exceed 1.0 (a bare <audio>.volume is hard-capped at 1.0 by the browser, which made
      // "200%" identical to "100%"). With webAudioMix, setVolume() drives a GainNode → real boost.
      // The page's context, created from the click that joined — see AudioPipeline.primeContext.
      // `true` would have LiveKit make its own, which is one more context to wake.
      webAudioMix: this._audioPipeline.context !== null
        ? { audioContext: this._audioPipeline.context }
        : true,
      // Adaptive features reduce quality based on subscriber viewport —
      // disable for "source" quality to maintain full resolution.
      adaptiveStream: !isSource,
      dynacast: !isSource,
      audioCaptureDefaults: micCaptureOptions(),
      videoCaptureDefaults: CAMERA_PRESETS[quality],
      publishDefaults: {
        videoEncoding: {
          maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
          maxFramerate: quality === "low" ? 15 : 30,
        },
        screenShareEncoding: {
          maxBitrate: SCREENSHARE_PUBLISH_BITRATES[quality],
          maxFramerate: quality === "low" ? 5 : quality === "medium" ? 15 : 30,
        },
      },
    });
    newRoom.on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    newRoom.on(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed);
    // Guests never pass through our WS presence, so members would never see them in the voice
    // roster. Mirror LiveKit's own participant list for guests only (members still come from WS).
    newRoom.on(RoomEvent.ParticipantConnected, this.handleParticipantConnected);
    newRoom.on(RoomEvent.ParticipantDisconnected, this.handleParticipantDisconnected);
    // A muted camera is NOT unsubscribed — the frozen last frame lingers. Treat a muted video
    // track as "gone" and an unmuted one as "back" so a guest's camera toggle updates cleanly.
    newRoom.on(RoomEvent.TrackMuted, this.handleTrackMuteChanged);
    newRoom.on(RoomEvent.TrackUnmuted, this.handleTrackMuteChanged);
    // A guest (un)publishing their mic is also a mute-state change for the roster.
    newRoom.on(RoomEvent.TrackPublished, (_pub, p) => this.syncGuestParticipant(p));
    newRoom.on(RoomEvent.TrackUnpublished, (_pub, p) => this.syncGuestParticipant(p));
    newRoom.on(RoomEvent.Disconnected, this.handleDisconnected);
    newRoom.on(RoomEvent.ActiveSpeakersChanged, this.handleActiveSpeakersChanged);
    newRoom.on(RoomEvent.AudioPlaybackStatusChanged, this.handleAudioPlaybackChanged);
    newRoom.on(RoomEvent.LocalTrackPublished, this.handleLocalTrackPublished);

    // Room lifecycle event logging for diagnostics
    newRoom.on(RoomEvent.Reconnecting, () => {
      log.warn("LiveKit room reconnecting");
    });
    newRoom.on(RoomEvent.Reconnected, () => {
      log.info("LiveKit room reconnected");
    });
    newRoom.on(RoomEvent.SignalReconnecting, () => {
      log.debug("LiveKit signal reconnecting");
    });
    newRoom.on(RoomEvent.MediaDevicesError, (error: Error) => {
      log.error("LiveKit media device error", { error: error.message });
    });
    newRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      // Feed the voice store so the dock/stage can show per-participant signal bars.
      // The local participant's identity is the same "user-{id}" shape as everyone's.
      const userId = parseUserId(participant.identity);
      if (userId !== 0) setConnQuality(userId, String(quality));
    });

    return newRoom;
  }

  // --- Module wiring helper ---

  /** Update all extracted modules with the current room reference. */
  private syncModuleRooms(): void {
    this._audioPipeline.setRoom(this.room);
    this._audioElements.setRoom(this.room);
    this._deviceManager.setRoom(this.room);
    this._deviceManager.setAudioPipeline(this.room !== null ? this._audioPipeline : null);
    this._deviceManager.setOnError(this.onErrorCallback);
    this._deviceManager.setOnToast(this.onErrorCallback);
  }

  // --- Room event handlers (arrow fns to preserve `this`) ---

  /** Defense in depth: when LiveKit (re)publishes a mic track during
   *  renegotiation, re-enforce the current mute state on the new track. */
  private handleLocalTrackPublished = (publication: LocalTrackPublication): void => {
    if (publication.source === Track.Source.Microphone) {
      const { localMuted, localDeafened } = voiceStore.getState();
      if (localMuted || localDeafened) {
        this.applyMicMuteState(true).catch((e) => log.warn("applyMicMuteState failed", e));
        log.debug("LocalTrackPublished: re-applied mute to mic track");
      }
    }
  };

  private handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      // Deafened must hold against tracks that appear AFTER the deafen toggle: mute is a
      // full unpublish/republish here, so every peer's mic toggle spawns a fresh
      // publication that autoSubscribe happily attaches — and sound leaked back in.
      if (voiceStore.getState().localDeafened) {
        publication.setSubscribed(false);
        log.debug("Refused audio track while deafened", { userId, trackSid: track.sid });
        return;
      }
      this._audioElements.handleTrackSubscribedAudio(track, publication, participant);
      // A re-subscribed track has a fresh RTCRtpReceiver — re-apply the enlarged jitter
      // buffer if this user's audio is being smoothed.
      this.applyAudioSmoothing(userId);
    } else if (track.kind === Track.Kind.Video) {
      if (userId !== 0 && this.onRemoteVideoCallback !== null && !publication.isMuted) {
        const stream = new MediaStream([track.mediaStreamTrack]);
        const isScreenshare = publication.source === Track.Source.ScreenShare;
        this.onRemoteVideoCallback(userId, stream, isScreenshare);
      }
      log.debug("Remote video track subscribed", { userId, trackSid: track.sid });
    }
  };

  // --- Per-user audio smoothing (jitter-buffer stretch) ---

  /** Users whose incoming mic audio gets an enlarged receive-side jitter buffer. Survives
   *  re-subscribes and rejoins within the session (it's a listener-side preference). */
  private smoothedAudioUsers = new Set<number>();
  /** Extra buffering when smoothing: absorbs ~250ms of network jitter at the cost of the
   *  same added latency. Big enough to swallow bursty Wi-Fi uplinks, small enough to talk. */
  private static readonly SMOOTH_JITTER_MS = 250;

  /** Toggle smoothing for one user's audio — a listener-side remedy for a CHOPPY remote
   *  participant (their bursty uplink / drifting clock). Trades latency for continuity. */
  setAudioSmoothing(userId: number, enabled: boolean): void {
    if (enabled) this.smoothedAudioUsers.add(userId);
    else this.smoothedAudioUsers.delete(userId);
    setAudioSmoothed(userId, enabled);
    this.applyAudioSmoothing(userId);
    log.info("Audio smoothing toggled", { userId, enabled });
  }

  /** Push the current smoothing target onto the user's live mic RTCRtpReceiver (no-op when
   *  they aren't publishing right now — handleTrackSubscribed re-applies on the next track). */
  private applyAudioSmoothing(userId: number): void {
    const room = this.room;
    if (room === null) return;
    const target = this.smoothedAudioUsers.has(userId)
      ? LiveKitSession.SMOOTH_JITTER_MS
      : null;
    for (const p of room.remoteParticipants.values()) {
      if (parseUserId(p.identity) !== userId) continue;
      const pub = p.getTrackPublication(Track.Source.Microphone);
      const receiver = (pub?.track as { receiver?: RTCRtpReceiver } | undefined)?.receiver as
        | (RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number | null })
        | undefined;
      if (!receiver) continue;
      try {
        // Standard knob (milliseconds) + the older Chrome spelling (seconds).
        if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = target;
        if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = target === null ? null : target / 1000;
      } catch (err) {
        log.warn("Failed to set jitter buffer target", { userId, err });
      }
    }
  }

  private handleTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      this._audioElements.handleTrackUnsubscribedAudio(track, publication, participant);
    } else if (track.kind === Track.Kind.Video) {
      track.detach();
      const isScreenshare = publication.source === Track.Source.ScreenShare;
      if (userId !== 0) this.onRemoteVideoRemovedCallback?.(userId, isScreenshare);
      log.debug("Remote video track unsubscribed", { userId, trackSid: track.sid });
    }
  };

  /** A guest joined the LiveKit room — put them in the voice roster (members come via WS,
   *  guests never do). Their negative id keeps them distinct from real members. */
  private handleParticipantConnected = (participant: RemoteParticipant): void => {
    this.syncGuestParticipant(participant);
  };

  private handleParticipantDisconnected = (participant: RemoteParticipant): void => {
    const id = parseUserId(participant.identity);
    if (id >= 0 || this.currentChannelId === null) return; // members handled by WS; guests are negative
    removeVoiceUser({ channel_id: this.currentChannelId, user_id: id });
  };

  /** Muting a camera does NOT unsubscribe it, so the frozen last frame would stay on screen.
   *  Map mute→remove and unmute→add for VIDEO tracks; guests toggle their camera this way. */
  private handleTrackMuteChanged = (
    publication: TrackPublication,
    participant: LKParticipant,
  ): void => {
    // Guests have no WS to announce their mute — LiveKit's track state IS their state.
    // Resync the roster row on every mute flip (no-op for members, whose truth is the WS).
    if (!participant.isLocal) this.syncGuestParticipant(participant);
    if (publication.kind !== Track.Kind.Video) return;
    const userId = parseUserId(participant.identity);
    if (userId === 0 || participant.isLocal) return;
    const isSs = publication.source === Track.Source.ScreenShare;
    if (publication.isMuted) {
      this.onRemoteVideoRemovedCallback?.(userId, isSs);
    } else {
      const track = (publication as RemoteTrackPublication).track;
      if (track?.mediaStreamTrack) {
        this.onRemoteVideoCallback?.(userId, new MediaStream([track.mediaStreamTrack]), isSs);
      }
    }
  };

  /** Seed guests who were ALREADY in the room when we connected — they emit no
   *  ParticipantConnected event for us, so without this a member joining an ongoing call
   *  wouldn't see the guests already talking. */
  private seedExistingGuests(channelId: number): void {
    if (this.room === null) return;
    for (const p of this.room.remoteParticipants.values()) this.syncGuestParticipant(p, channelId);
  }

  /** Add a guest participant to the voice roster (no-op for members / self). Also seeds guests
   *  who were ALREADY in the room when we joined. `channelId` is passed explicitly during seeding
   *  because that runs right after connect, BEFORE this.currentChannelId is set — relying on the
   *  field there dropped every guest already in the room (a member saw only later arrivals). */
  private syncGuestParticipant(participant: Participant, channelId = this.currentChannelId): void {
    const id = parseUserId(participant.identity);
    if (id >= 0 || channelId === null) return; // only guests (negative id)
    const camPub = participant.getTrackPublication(Track.Source.Camera);
    const ssPub = participant.getTrackPublication(Track.Source.ScreenShare);
    updateVoiceState({
      channel_id: channelId,
      user_id: id,
      username: participant.name || "Гость",
      muted: participant.getTrackPublication(Track.Source.Microphone)?.isMuted ?? false,
      deafened: false,
      speaking: participant.isSpeaking,
      camera: !!camPub && !camPub.isMuted,
      screenshare: !!ssPub && !ssPub.isMuted,
    });
  }

  /** LiveKit's built-in speaking detection — replaces custom RMS polling. */
  private handleActiveSpeakersChanged = (speakers: Participant[]): void => {
    if (this.currentChannelId === null) return;
    const speakerIds: number[] = [];
    for (const speaker of speakers) {
      const userId = parseUserId(speaker.identity);
      if (userId !== 0) speakerIds.push(userId); // members (+) and guests (−)
    }
    speakerIds.sort((x, y) => x - y);
    setSpeakers({ channel_id: this.currentChannelId, speakers: speakerIds });
  };

  /**
   * Which ICE path media actually took. A carrier that blocks UDP silently drops the call to
   * TCP (or a relay), which is far more jittery — the usual reason a call is fine on Wi-Fi and
   * ragged on mobile data. Read from public track stats rather than the SDK's internals.
   */
  /** Held for the duration of a call: on a phone, a locked screen suspends the tab and the
   *  microphone with it. Absent on older iOS — then this is simply a no-op. */
  private wakeLock: WakeLockSentinel | null = null;

  private async acquireWakeLock(): Promise<void> {
    try {
      this.wakeLock ??= await navigator.wakeLock?.request("screen");
      // iOS drops the lock whenever the tab is backgrounded; take it again on return.
      this.wakeLock?.addEventListener("release", () => { this.wakeLock = null; });
    } catch (err) {
      log.debug("Wake lock unavailable", err);
    }
  }

  private releaseWakeLock(): void {
    void this.wakeLock?.release().catch(() => { /* already gone */ });
    this.wakeLock = null;
  }

  /** Called by the "enable sound" button the dock shows while playback is blocked. */
  async unlockAudio(): Promise<void> {
    // While the click is still in hand — Firefox and Safari grant an AudioContext only here.
    this._audioPipeline.primeContext();
    await this.startAudioNow();
  }

  private async measureTransport(): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      const sender = [...room.localParticipant.audioTrackPublications.values()][0]?.track?.sender;
      const receiver = [...room.remoteParticipants.values()]
        .flatMap((p) => [...p.audioTrackPublications.values()])[0]?.track?.receiver;
      const stats = await (sender?.getStats() ?? receiver?.getStats() ?? Promise.resolve(null));
      if (!stats) return;

      // Collected rather than tracked through the callback: assignments inside forEach are
      // invisible to the type narrower.
      const pairs: RTCIceCandidatePairStats[] = [];
      const candidates = new Map<string, IceCandidateStats>();
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && (r as RTCIceCandidatePairStats).state === "succeeded") {
          pairs.push(r as RTCIceCandidatePairStats);
        } else if (r.type === "local-candidate") {
          candidates.set(r.id, r as unknown as IceCandidateStats);
        }
      });
      const pair = pairs[0];
      if (!pair) return;
      const local = candidates.get(pair.localCandidateId ?? "");
      const kind = local?.candidateType === "relay"
        ? `relay/${local.relayProtocol ?? local.protocol ?? "?"}`
        : (local?.protocol ?? null);
      setVoiceTransport(kind);
      log.info("Voice transport", { kind, candidateType: local?.candidateType });
    } catch (err) {
      log.debug("Could not read voice transport stats", err);
    }
  }

  /**
   * Autoplay unlock: browsers block audio playback without user interaction.
   * When LiveKit reports audio can't play, we register a one-time click handler
   * on document that calls room.startAudio() — the next click anywhere unlocks audio.
   */
  private autoplayUnlockHandler: (() => void) | null = null;

  /** Gestures the browsers accept as "the user is here". pointerdown fires before click and
   *  survives a drag that never becomes one; keydown covers whoever never touches the mouse. */
  private static readonly UNLOCK_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

  /**
   * Set only once room.startAudio() has actually RESOLVED.
   *
   * Not the same thing as room.canPlaybackAudio, and the difference cost a call: with
   * webAudioMix LiveKit recomputes that flag inside acquireAudioContext from the AudioContext
   * state alone, so a startAudio() whose element play() the browser refused still ends with
   * "playback allowed" three milliseconds later. Firefox refuses that play() on a tab the user
   * has not clicked in — and we took the flag at its word, stood the unlock handler down, and
   * left the tab permanently mute with the remote track subscribed, the meters moving and no
   * way for anyone to ask again.
   */
  private audioStarted = false;

  /** The one place playback is started. Re-arms on refusal instead of giving up. */
  private async startAudioNow(): Promise<void> {
    if (this.room === null) return;
    try {
      await this.room.startAudio();
      this.audioStarted = true;
      setAudioBlocked(false);
      log.info("Audio playback started");
    } catch (err) {
      // Either no gesture was in hand, or an element still refuses. Wait for the next one.
      log.debug("startAudio refused — waiting for another gesture", err);
      this.armAutoplayUnlock();
    }
  }

  private armAutoplayUnlock(): void {
    if (this.autoplayUnlockHandler !== null) return; // already waiting for a gesture
    const handler = (): void => {
      this.removeAutoplayUnlock();
      void this.startAudioNow();
    };
    this.autoplayUnlockHandler = handler;
    for (const e of LiveKitSession.UNLOCK_EVENTS) {
      document.addEventListener(e, handler, { passive: true });
    }
  }

  private handleAudioPlaybackChanged = (): void => {
    if (this.room === null) return;
    if (this.room.canPlaybackAudio) {
      setAudioBlocked(false);
      // Stand down ONLY when playback really started. "Allowed" on its own is the context
      // reporting itself running — see audioStarted.
      if (this.audioStarted) {
        log.info("Audio playback is now allowed");
        this.removeAutoplayUnlock();
      } else {
        this.armAutoplayUnlock();
      }
      return;
    }
    // A gesture ANYWHERE unlocks it — but on a phone the visitor may never make one, and the
    // room just looks dead. The store flag puts a visible button in front of them.
    setAudioBlocked(true);
    log.warn("Audio playback blocked by browser — registering click-to-unlock");
    this.armAutoplayUnlock();
  };

  private removeAutoplayUnlock(): void {
    if (this.autoplayUnlockHandler !== null) {
      for (const e of LiveKitSession.UNLOCK_EVENTS) {
        document.removeEventListener(e, this.autoplayUnlockHandler);
      }
      this.autoplayUnlockHandler = null;
    }
  }

  private handleDisconnected = (reason?: DisconnectReason): void => {
    log.info("LiveKit room disconnected", { reason });
    // During the initial connect/retry loop in handleVoiceToken, let that loop
    // handle failures. If we run leaveVoice() here it nulls this.room, which
    // causes the retry loop to abort immediately (this.room === null guard).
    if (this.connecting) {
      log.info("Disconnect during initial connect — deferring to retry loop");
      return;
    }
    // We were REPLACED, not dropped: another device of this account joined the same room
    // (both carry identity "user-{id}", so LiveKit evicts the incumbent), or the server
    // removed us. Reconnecting with the stored token here starts a war — the two devices
    // kick each other in a loop until every session is dead and the room refuses everyone
    // for a while. Hand the call over instead: tear down, keep the roster presence.
    if (reason === DisconnectReason.DUPLICATE_IDENTITY || reason === DisconnectReason.PARTICIPANT_REMOVED) {
      log.info("Replaced by another device — handing the voice session over");
      this.leaveVoice(false);
      leaveVoiceChannel(true);
      return;
    }
    const isUnexpected = reason !== DisconnectReason.CLIENT_INITIATED;
    if (isUnexpected && this.latestToken !== null && this.currentChannelId !== null && this.lastUrl !== null) {
      // Attempt auto-reconnect with stored token before giving up.
      const token = this.latestToken;
      const url = this.lastUrl;
      const channelId = this.currentChannelId;
      const directUrl = this.lastDirectUrl;
      // Clean up current room without sending WS leave (we're reconnecting, not leaving).
      this._audioPipeline.teardownAudioPipeline();
      this.removeAutoplayUnlock();
      this.clearTokenRefreshTimer();
      // Clear stale remote audio elements so reconnect doesn't leak DOM nodes.
      this._audioElements.cleanupAllAudioElements();
      if (this.room !== null) {
        const r = this.room;
        this.room = null;
        this.syncModuleRooms();
        r.removeAllListeners();
        r.disconnect().catch((err) => log.warn("Failed to disconnect stale room", err));
      }
      this.reconnectAc = new AbortController();
      void this.attemptAutoReconnect(token, url, channelId, directUrl, this.reconnectAc.signal);
      return;
    }
    this.leaveVoice(false);
    leaveVoiceChannel();
    if (isUnexpected) this.onErrorCallback?.("Voice connection lost — disconnected");
  };

  /** Attempt to auto-reconnect after unexpected disconnect using stored token.
   *  The signal is aborted by leaveVoice() to cancel the loop when the user
   *  voluntarily leaves voice during the reconnect delay. */
  private async attemptAutoReconnect(
    token: string, url: string, channelId: number, directUrl: string | undefined, signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; attempt <= LiveKitSession.MAX_RECONNECT_ATTEMPTS; attempt++) {
      log.info("Auto-reconnect attempt", { attempt, maxAttempts: LiveKitSession.MAX_RECONNECT_ATTEMPTS });
      await new Promise((r) => setTimeout(r, LiveKitSession.RECONNECT_DELAY_MS));
      // If user manually left or joined a different channel during the delay, abort.
      if (signal.aborted || this.currentChannelId !== channelId) {
        log.info("Auto-reconnect aborted — user left or channel changed");
        return;
      }
      try {
        this.room = this.createRoom();
        this.syncModuleRooms();
        const resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);
        await this.room.connect(resolvedUrl, token);
        this.seedExistingGuests(channelId);
        log.info("Auto-reconnect succeeded", { attempt, channelId, url: resolvedUrl });
        this.logIceConnectionInfo();
        void this.startAudioNow();
        await this.restoreLocalVoiceState("reconnect");
        this._audioPipeline.setupAudioPipeline();
        this.reapplyMuteGain();
        this.startTokenRefreshTimer();
        // Clear the abort controller after all post-connect work is done so
        // leaveVoice() can still abort during restoreLocalVoiceState above.
        this.reconnectAc = null;
        // Request a fresh token since the stored one may be close to expiry.
        this.requestTokenRefresh();
        return;
      } catch (err) {
        log.warn("Auto-reconnect failed", { attempt, url, error: err });
        if (this.room !== null) {
          this.room.removeAllListeners();
          this.room.disconnect().catch((err) => log.warn("Failed to disconnect room after reconnect failure", err));
          this.room = null;
          this.syncModuleRooms();
        }
      }
    }
    // All attempts exhausted — give up and clean up.
    // Send voice_leave over WS so the server removes our voice state;
    // without this the server and other clients see us as a ghost participant.
    log.error("Auto-reconnect exhausted all attempts, giving up");
    this.leaveVoice(true);
    leaveVoiceChannel();
    this.onErrorCallback?.("Voice connection lost — failed to reconnect");
  }

  // --- URL resolution ---

  private async resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string> {
    // A runtime override (subdomain ingress, e.g. wss://livekit.outcome.io) wins over the proxy.
    const rt = runtimeLivekitUrl();
    if (rt) return rt;
    // The instance we are signed into, authority AND scheme together. Deriving either of them
    // from window.location is right on the web and wrong in the desktop shell, where the page
    // comes from app://outcome: the host became "outcome" and the protocol was neither http nor
    // https, so this produced ws://outcome/livekit and the call simply never connected. The
    // microphone worked perfectly the entire time, which is what made it look like a mic bug.
    const origin = serverOrigin();
    if (origin) {
      const hostname = new URL(origin).hostname;
      const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
      if (isLocal && directUrl) {
        log.debug("LiveKit URL resolved via direct (local)", { url: directUrl });
        return directUrl;
      }
      if (proxyPath.startsWith("/")) {
        // The /livekit proxy on that instance (nginx → backend → livekit). http→ws, https→wss,
        // taken from the origin rather than guessed.
        const resolved = `${origin.replace(/^http/, "ws")}${proxyPath}`;
        log.debug("LiveKit URL resolved via same-origin proxy", { url: resolved });
        return resolved;
      }
    }
    log.debug("LiveKit URL resolved as passthrough", { url: proxyPath });
    return proxyPath;
  }

  // --- Token refresh ---

  /** Token refresh interval: 23 hours (refresh 1h before 24h TTL expiry). */
  private static readonly TOKEN_REFRESH_MS = 23 * 60 * 60 * 1000;

  private startTokenRefreshTimer(): void {
    this.clearTokenRefreshTimer();
    this.tokenRefreshTimer = setTimeout(() => {
      this.requestTokenRefresh();
    }, LiveKitSession.TOKEN_REFRESH_MS);
    log.debug("Token refresh timer started", { refreshInMs: LiveKitSession.TOKEN_REFRESH_MS });
  }

  private clearTokenRefreshTimer(): void {
    if (this.tokenRefreshTimer !== null) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  private requestTokenRefresh(): void {
    if (this.ws === null || this.room === null) {
      log.debug("Skipping token refresh — no active session");
      return;
    }
    log.info("Requesting voice token refresh");
    this.ws.send({ type: "voice_token_refresh", payload: {} });
    // NOTE: startTokenRefreshTimer is called from handleVoiceTokenRefresh
    // (the server response handler), not here, to avoid scheduling two
    // competing timers per cycle.
  }

  handleVoiceTokenRefresh(token?: string): void {
    // KNOWN LIMITATION: The livekit-client SDK does not expose a method to
    // rotate the token on an active connection. We store the fresh token so
    // that reconnection (auto-reconnect or manual rejoin) uses it, but the
    // live session continues with the original token. This means:
    //   - Sessions longer than the 4h TTL remain connected (LiveKit keeps
    //     active connections alive) but lose the ability to reconnect after a
    //     network blip once the original token expires.
    //   - The 23h refresh timer ensures a fresh token is always ready
    //     *before* the original expires, so reconnects within the window work.
    // See also: Server/ws/livekit.go tokenTTL constant.
    if (token) {
      this.latestToken = token;
    }
    this.startTokenRefreshTimer();
    log.info("Voice token refreshed, timer restarted");
  }

  // --- Volume helpers ---

  /** Compute the effective volume for a participant: per-user volume * master output. */
  private getEffectiveVolume(userId: number): number {
    return this._audioElements.getEffectiveVolume(userId);
  }

  private getScreenshareOutputVolume(): number {
    return Math.max(0, Math.min(1, this.outputVolumeMultiplier));
  }

  private getLocalVoiceFlags(): { muted: boolean; deafened: boolean } {
    const state = voiceStore.getState();
    return {
      muted: state.localMuted || state.localDeafened,
      deafened: state.localDeafened,
    };
  }

  private applyRemoteAudioSubscriptionState(deafened: boolean): void {
    this._audioElements.applyRemoteAudioSubscriptionState(deafened);
  }

  private async restoreLocalVoiceState(mode: "join" | "reconnect"): Promise<void> {
    if (this.room === null) return;

    const { muted, deafened } = this.getLocalVoiceFlags();
    const shouldEnableMicrophone = !muted;

    // voice_join carries only the channel id, so the server (re)initializes our flags as
    // unmuted — re-announce any non-default state or everyone else sees us wrong after a
    // reconnect (locally muted, publicly "live").
    if (muted) this.ws?.send({ type: "voice_mute", payload: { muted: true } });
    if (deafened) this.ws?.send({ type: "voice_deafen", payload: { deafened: true } });

    try {
      await this.room.localParticipant.setMicrophoneEnabled(shouldEnableMicrophone);
      if (shouldEnableMicrophone) {
        log.info(mode === "join"
          ? "Published mic via LiveKit native capture"
          : "Auto-reconnect restored live microphone");
        if (loadPref<boolean>("enhancedNoiseSuppression", true)) {
          await this._audioPipeline.applyNoiseSuppressor();
        }
      }
      setListenOnly(false); // Mic acquired successfully
    } catch (micErr) {
      setListenOnly(true);
      if (mode === "reconnect") {
        log.warn("Auto-reconnect: mic unavailable — listen-only mode", micErr);
      } else if (micErr instanceof DOMException && micErr.name === "NotAllowedError") {
        log.warn("Microphone permission denied — joined in listen-only mode");
        this.onErrorCallback?.("Microphone permission denied — joined in listen-only mode");
      } else if (micErr instanceof DOMException && micErr.name === "NotFoundError") {
        log.warn("No microphone found — joined in listen-only mode");
        this.onErrorCallback?.("No microphone found — joined in listen-only mode");
      } else {
        log.warn("Microphone unavailable — joined in listen-only mode", micErr);
        this.onErrorCallback?.("Microphone unavailable — joined in listen-only mode");
      }
    }

    // Always enforce mute at the track level even if no pipeline exists yet.
    // setMicrophoneEnabled(false) doesn't guarantee mediaStreamTrack.enabled=false,
    // and renegotiation when a new participant joins can bring a track back alive.
    if (muted) {
      this.applyMicMuteState(true).catch((e) => log.warn("applyMicMuteState failed in restoreLocalVoiceState", e));
    }

    this.applyRemoteAudioSubscriptionState(deafened);
  }

  /** Apply effective volume to all remote participants. */
  private applyAllVolumes(): void {
    this._audioElements.applyAllVolumes();
  }

  // --- Public API ---

  setWsClient(client: WsClient): void { this.ws = client; }
  setServerHost(host: string): void { this.serverHost = host; }
  setOnError(cb: (message: string) => void): void {
    this.onErrorCallback = cb;
    this._deviceManager.setOnError(cb);
  }
  clearOnError(): void {
    this.onErrorCallback = null;
    this._deviceManager.setOnError(null);
  }
  setOnRemoteVideo(cb: RemoteVideoCallback): void {
    this.onRemoteVideoCallback = cb;
    // Replay video tracks that were subscribed BEFORE this callback was registered — a
    // component that (re)mounts mid-call (switching views and back) would otherwise show
    // no remote camera/screenshare until the sharer toggles it off and on again.
    if (this.room !== null) {
      for (const participant of this.room.remoteParticipants.values()) {
        const userId = parseUserId(participant.identity);
        if (userId === 0) continue;
        for (const pub of participant.trackPublications.values()) {
          const track = pub.track;
          if (track === undefined || track.kind !== Track.Kind.Video || pub.isMuted) continue;
          const stream = new MediaStream([track.mediaStreamTrack]);
          cb(userId, stream, pub.source === Track.Source.ScreenShare);
        }
      }
    }
  }
  setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void { this.onRemoteVideoRemovedCallback = cb; }

  clearOnRemoteVideo(): void {
    this.onRemoteVideoCallback = null;
    this.onRemoteVideoRemovedCallback = null;
  }

  async handleVoiceToken(
    token: string, url: string, channelId: number, directUrl?: string, sharedKey?: string,
  ): Promise<void> {
    if (this.room !== null && this.currentChannelId === channelId
        && this.room.state === "connected") {
      // handleVoiceTokenRefresh internally calls startTokenRefreshTimer,
      // so we must NOT call startTokenRefreshTimer again after this.
      this.handleVoiceTokenRefresh(token);
      return;
    }
    // Prevent concurrent connect attempts (rapid channel switching).
    if (this.connecting) {
      this.pendingJoin = { token, url, channelId, directUrl };
      log.warn("handleVoiceToken: already connecting, queued latest join request", { channelId });
      return;
    }
    if (this.room !== null) this.leaveVoice(false);
    this.connecting = true;
    let resolvedUrl = "";
    try {
      this.room = this.createRoom();
      this.syncModuleRooms();
      resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 2000;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await this.room.connect(resolvedUrl, token);
          this.seedExistingGuests(channelId);
          const queuedJoin = this.pendingJoin;
          if (queuedJoin !== null
              && (queuedJoin.token !== token
                || queuedJoin.url !== url
                || queuedJoin.channelId !== channelId
                || queuedJoin.directUrl !== directUrl)) {
            log.info("Discarding stale voice join in favor of queued request", {
              channelId,
              queuedChannelId: queuedJoin.channelId,
            });
            if (this.room !== null) {
              const room = this.room;
              this.room = null;
              this.syncModuleRooms();
              room.removeAllListeners();
              room.disconnect().catch((err) => log.debug("Failed to disconnect room during cleanup", err));
            }
            // Don't return — fall through to finally + pending-join dispatch.
            break;
          }
          break;
        } catch (connectErr) {
          if (attempt < MAX_RETRIES) {
            log.warn("LiveKit connect failed, retrying", { attempt, maxRetries: MAX_RETRIES, url: resolvedUrl, error: connectErr });
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            if (this.room === null) throw connectErr;
            this.room.removeAllListeners();
            this.room = this.createRoom();
            this.syncModuleRooms();
          } else {
            throw connectErr;
          }
        }
      }
      // If the room was discarded (stale join superseded by pending), skip setup.
      if (this.room !== null) {
        log.info("Connected to LiveKit room", { channelId, url: resolvedUrl });
        this.logIceConnectionInfo();
        this.currentChannelId = channelId;
        this.latestToken = token;
        this.lastUrl = url;
        this.lastDirectUrl = directUrl;
        // Optimistic startAudio — may succeed if the join was triggered by a
        // recent user gesture. If not, the AudioPlaybackStatusChanged handler
        // will register a click-to-unlock fallback.
        void this.startAudioNow();
        // Locking the screen suspends the tab, and with it the microphone. Held for the call.
        void this.acquireWakeLock();
        window.setTimeout(() => void this.measureTransport(), 3000);
        await this.restoreLocalVoiceState("join");
        const savedInput = loadPref<string>("audioInputDevice", "");
        if (savedInput) {
          try {
            await this.room.switchActiveDevice("audioinput", savedInput);
          } catch (err) {
            log.warn("Saved input device unavailable, using default", err);
          }
        }
        const savedOutput = loadPref<string>("audioOutputDevice", "");
        if (savedOutput) {
          try {
            await this.room.switchActiveDevice("audiooutput", savedOutput);
          } catch (err) {
            log.warn("Saved output device unavailable, using default", err);
          }
        }
        // Set up unified audio pipeline (input volume + VAD gating via GainNode).
        // VAD polling only starts if saved sensitivity < 100.
        this._audioPipeline.setupAudioPipeline();
        this.reapplyMuteGain();
        this.startTokenRefreshTimer();
        log.info("Voice session active", { channelId });
      }
    } catch (err) {
      log.error("Failed to connect to LiveKit", { url: resolvedUrl, error: err });
      if (this.room !== null) {
        this.onErrorCallback?.("Failed to join voice — connection error");
      }
      this.leaveVoice(false);
    } finally {
      this.connecting = false;
    }
    // Dispatch pending join *after* the try/finally so that a throw inside
    // the recursive call doesn't interfere with the outer finally's flag reset.
    const pendingJoin = this.pendingJoin;
    this.pendingJoin = null;
    if (pendingJoin !== null) {
      await this.handleVoiceToken(
        pendingJoin.token,
        pendingJoin.url,
        pendingJoin.channelId,
        pendingJoin.directUrl,
      );
    }
  }

  /** Retry microphone permission after being in listen-only mode. */
  async retryMicPermission(): Promise<void> {
    if (this.room === null) return;
    this._audioPipeline.primeContext();
    try {
      await this.room.localParticipant.setMicrophoneEnabled(true);
      setListenOnly(false);
      setLocalMuted(false);
      log.info("Microphone permission granted — exited listen-only mode");
      // Set up audio pipeline for the new mic track
      this._audioPipeline.setupAudioPipeline();
      if (loadPref<boolean>("enhancedNoiseSuppression", true)) {
        await this._audioPipeline.applyNoiseSuppressor();
      }
    } catch (err) {
      log.warn("Microphone retry failed — still in listen-only mode", err);
      this.onErrorCallback?.("Microphone still unavailable — check your browser permissions");
    }
  }

  leaveVoice(sendWs = true): void {
    // Cancel any pending auto-reconnect loop first
    if (this.reconnectAc !== null) {
      this.reconnectAc.abort();
      this.reconnectAc = null;
    }
    this.clearTokenRefreshTimer();
    this.releaseWakeLock();
    setVoiceTransport(null);
    setAudioBlocked(false);
    this._audioPipeline.teardownAudioPipeline();
    // The graph goes with the pipeline; the context outlives it by design (the room and the
    // denoiser share it) and is closed only when the call is actually over.
    this._audioPipeline.closeContext();
    this.removeAutoplayUnlock();
    this.pendingJoin = null;
    // Clean up manually published tracks.
    if (this.manualCameraTrack !== null) { this.manualCameraTrack.stop(); this.manualCameraTrack = null; }
    for (const t of this.manualScreenTracks) t.stop();
    this.manualScreenTracks = [];
    // Drop the self-view wrapper too — it holds a now-ended track and would render a dead tile.
    this.localScreenStream = null;
    if (sendWs && this.ws !== null) {
      this.ws.send({ type: "voice_leave", payload: {} });
    }
    // Remove orphaned remote audio elements (normally cleaned up by
    // TrackUnsubscribed, but may be missed during rapid reconnection).
    this._audioElements.cleanupAllAudioElements();
    if (this.room !== null) {
      const r = this.room;
      this.room = null;
      this.syncModuleRooms();
      r.removeAllListeners();
      r.disconnect().catch((err) => log.warn("room.disconnect() error (non-fatal)", err));
    }
    this.currentChannelId = null;
    this.latestToken = null;
    this.lastUrl = null;
    this.lastDirectUrl = undefined;
    setLocalCamera(false);
    setLocalScreenshare(false);
    log.info("Left voice session");
  }

  cleanupAll(): void {
    this.leaveVoice(false);
    this.onErrorCallback = null;
    this.onRemoteVideoCallback = null;
    this.onRemoteVideoRemovedCallback = null;
    this.ws = null;
    this.serverHost = null;
    this.liveKitProxyPort = null;
  }

  setMuted(muted: boolean): void {
    // Unmuting is a click, and it is the last moment a browser will hand out a live
    // AudioContext. Priming it here rather than after the awaits below is the difference
    // between a pipeline that runs and one that publishes silence.
    if (!muted) this._audioPipeline.primeContext();
    setLocalMuted(muted);
    // Tell the server (which broadcasts VoiceState) — without this, nobody else ever
    // learns the mic is off and the 🔇 badge never shows on other clients.
    this.ws?.send({ type: "voice_mute", payload: { muted } });
    this.applyMicMuteState(muted).catch((e) => log.warn("applyMicMuteState failed", e));
  }

  setDeafened(deafened: boolean): void {
    setLocalDeafened(deafened);
    this.ws?.send({ type: "voice_deafen", payload: { deafened } });
    this.applyRemoteAudioSubscriptionState(deafened);
    const shouldMute = deafened || voiceStore.getState().localMuted;
    this.applyMicMuteState(shouldMute).catch((e) => log.warn("applyMicMuteState failed", e));
    log.debug("Deafen state changed", { deafened });
  }

  /** Nuclear mute: fully unpublish the mic track when muting and tear down
   *  the audio pipeline. Re-publish and rebuild when unmuting. This guarantees
   *  the SFU has no audio track to forward to other participants. */
  private async applyMicMuteState(muted: boolean): Promise<void> {
    if (this.room === null) return;
    if (muted) {
      // Tear down pipeline first so it doesn't hold refs to the track
      this._audioPipeline.teardownAudioPipeline();
      // Fully disable the mic — this unpublishes the track from the SFU
      await this.room.localParticipant.setMicrophoneEnabled(false);
      log.debug("Mic fully unpublished (muted)");
    } else {
      // Re-enable mic — this re-publishes the track to the SFU
      await this.room.localParticipant.setMicrophoneEnabled(true);
      // Rebuild the audio pipeline on the fresh track
      this._audioPipeline.setupAudioPipeline();
      log.debug("Mic re-published (unmuted)");
    }
  }

  async enableCamera(): Promise<void> {
    if (this.room === null || this.ws === null) {
      log.warn("Cannot enable camera: no active voice session");
      this.onErrorCallback?.("Join a voice channel first");
      return;
    }
    setLocalCamera(true);
    const quality = getStreamQuality();
    try {
      const savedVideoDevice = loadPref<string>("videoInputDevice", "");
      // Stop any existing manual camera track before creating a new one.
      this.stopManualCameraTrack();
      const videoTrack = await createLocalVideoTrack({
        ...CAMERA_PRESETS[quality],
        ...(savedVideoDevice ? { deviceId: savedVideoDevice } : {}),
      });
      this.manualCameraTrack = videoTrack;
      await this.room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.Camera,
        simulcast: quality !== "source",
        videoEncoding: {
          maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
          maxFramerate: quality === "low" ? 15 : 30,
        },
      });
      this.ws.send({ type: "voice_camera", payload: { enabled: true } });
      // Re-apply audio pipeline — publishing a new track can trigger WebRTC
      // renegotiation which resets the mic sender, bypassing our GainNode mute.
      this._audioPipeline.setupAudioPipeline();
      this.reapplyMuteGain();
      log.info("Camera enabled", { quality, maxBitrate: CAMERA_PUBLISH_BITRATES[quality] });
    } catch (err) {
      setLocalCamera(false);
      log.error("Failed to enable camera", err);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        this.onErrorCallback?.("Camera permission denied");
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        this.onErrorCallback?.("No camera found");
      } else {
        this.onErrorCallback?.("Failed to start camera");
      }
    }
  }

  async disableCamera(): Promise<void> {
    try {
      this.stopManualCameraTrack();
      // Also call setCameraEnabled(false) as a fallback to clean up any
      // LiveKit-managed camera track that might exist.
      if (this.room !== null) await this.room.localParticipant.setCameraEnabled(false);
    } catch (err) {
      log.warn("Failed to disable camera track (non-fatal)", err);
    } finally {
      setLocalCamera(false);
      if (this.ws !== null) this.ws.send({ type: "voice_camera", payload: { enabled: false } });
      log.info("Camera disabled");
    }
  }

  private stopManualCameraTrack(): void {
    if (this.manualCameraTrack === null) return;
    const track = this.manualCameraTrack;
    this.manualCameraTrack = null;
    // Unpublish is best-effort (room may already be gone) but the capture track must ALWAYS
    // be stopped — otherwise the browser's camera indicator stays on with no way to stop it.
    if (this.room !== null) {
      try {
        void this.room.localParticipant.unpublishTrack(track.mediaStreamTrack);
      } catch { /* already unpublished */ }
    }
    track.stop();
  }

  async enableScreenshare(): Promise<void> {
    if (this.room === null || this.ws === null) {
      log.warn("Cannot enable screenshare: no active voice session");
      this.onErrorCallback?.("Join a voice channel first");
      return;
    }
    const quality = getStreamQuality();

    // Prompt for the screen. A throw here is usually the user cancelling the
    // picker or denying permission — not a failure worth tearing anything down.
    let screenTracks: LocalTrack[];
    try {
      this.stopManualScreenTracks();
      screenTracks = await createLocalScreenTracks(SCREENSHARE_PRESETS[quality]);
    } catch (err) {
      log.info("Screenshare not started (picker cancelled or denied)", err);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        this.onErrorCallback?.("Screen sharing permission denied");
      } else {
        this.onErrorCallback?.("Failed to start screen sharing");
      }
      return;
    }

    this.manualScreenTracks = screenTracks;
    const videoTrack = screenTracks.find((tk) => tk.kind === Track.Kind.Video);
    const audioTrack = screenTracks.find((tk) => tk.kind === Track.Kind.Audio);

    if (videoTrack === undefined) {
      log.error("Screenshare produced no video track");
      this.stopManualScreenTracks();
      this.onErrorCallback?.("Failed to start screen sharing");
      return;
    }

    // Wrap the local video track so the sharer previews their OWN screen.
    this.localScreenStream = videoTrack.mediaStreamTrack
      ? new MediaStream([videoTrack.mediaStreamTrack])
      : null;

    // Publish the VIDEO track — this IS the screenshare. If it fails, abort cleanly.
    try {
      await this.room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: false,  // No simulcast for screenshare — send full quality
        videoEncoding: {
          maxBitrate: SCREENSHARE_PUBLISH_BITRATES[quality],
          maxFramerate: quality === "low" ? 5 : quality === "medium" ? 15 : 30,
        },
      });
    } catch (err) {
      log.error("Failed to publish screenshare video", err);
      this.stopManualScreenTracks();
      this.localScreenStream = null;
      setLocalScreenshare(false);
      this.onErrorCallback?.("Failed to start screen sharing");
      return;
    }

    // Screen video is live → reflect it in the UI immediately (self-preview tile + others).
    setLocalScreenshare(true);
    // ws may have been torn down (logout) while the picker/publish awaits were in flight.
    this.ws?.send({ type: "voice_screenshare", payload: { enabled: true } });

    // System audio is BEST-EFFORT: Firefox/Safari often can't capture it, and a
    // failure here must never tear down the working video share.
    if (audioTrack !== undefined) {
      try {
        await this.room.localParticipant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
      } catch (err) {
        log.warn("Screenshare system audio not published (browser limitation)", err);
      }
    }

    // Re-apply audio pipeline — same renegotiation risk as camera.
    this._audioPipeline.setupAudioPipeline();
    this.reapplyMuteGain();
    log.info("Screenshare enabled", { quality, maxBitrate: SCREENSHARE_PUBLISH_BITRATES[quality] });
  }

  async disableScreenshare(): Promise<void> {
    try {
      this.stopManualScreenTracks();
      if (this.room !== null) await this.room.localParticipant.setScreenShareEnabled(false);
    } catch (err) {
      log.warn("Failed to disable screenshare track (non-fatal)", err);
    } finally {
      setLocalScreenshare(false);
      if (this.ws !== null) this.ws.send({ type: "voice_screenshare", payload: { enabled: false } });
      log.info("Screenshare disabled");
    }
  }

  private stopManualScreenTracks(): void {
    this.localScreenStream = null;
    if (this.manualScreenTracks.length === 0) return;
    const tracks = this.manualScreenTracks;
    this.manualScreenTracks = [];
    for (const track of tracks) {
      // Unpublish is best-effort (voice may have dropped while the picker was open) but the
      // capture track must ALWAYS be stopped — otherwise the browser keeps showing the
      // "sharing your screen" indicator with nothing able to turn it off.
      if (this.room !== null) {
        try {
          void this.room.localParticipant.unpublishTrack(track.mediaStreamTrack);
        } catch { /* already unpublished */ }
      }
      track.stop();
    }
  }

  // --- Delegating methods to DeviceManager ---

  async switchInputDevice(deviceId: string): Promise<void> {
    return this._deviceManager.switchInputDevice(deviceId);
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    return this._deviceManager.switchOutputDevice(deviceId);
  }

  // --- Delegating methods to AudioElements ---

  setUserVolume(userId: number, volume: number): void {
    this._audioElements.setUserVolume(userId, volume);
  }

  getUserVolume(userId: number): number { return this._audioElements.getUserVolume(userId); }

  setScreenshareAudioVolume(userId: number, volume: number): void {
    this._audioElements.setScreenshareAudioVolume(userId, volume);
  }

  muteScreenshareAudio(userId: number, muted: boolean): void {
    this._audioElements.muteScreenshareAudio(userId, muted);
  }

  getScreenshareAudioMuted(userId: number): boolean {
    return this._audioElements.getScreenshareAudioMuted(userId);
  }

  // --- Audio pipeline delegates (all state lives in AudioPipeline) ---

  /** Re-apply mute/deafen state after events that may reset the audio pipeline. */
  private reapplyMuteGain(): void {
    const { localMuted, localDeafened } = voiceStore.getState();
    if (localMuted || localDeafened) {
      this.applyMicMuteState(true).catch((e) => log.warn("applyMicMuteState failed", e));
    }
  }

  setInputVolume(volume: number): void {
    this._audioPipeline.setInputVolume(volume);
  }

  setOutputVolume(volume: number): void {
    this._audioElements.setOutputVolume(volume);
  }

  setVoiceSensitivity(sensitivity: number): void {
    this._audioPipeline.setVoiceSensitivity(sensitivity);
  }

  async reapplyAudioProcessing(): Promise<void> {
    return this._audioPipeline.reapplyAudioProcessing(this.onErrorCallback ?? undefined);
  }

  getLocalCameraStream(): MediaStream | null {
    if (this.room === null) return null;
    const cameraPub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (cameraPub?.track?.mediaStreamTrack) return new MediaStream([cameraPub.track.mediaStreamTrack]);
    return null;
  }

  getLocalScreenshareStream(): MediaStream | null {
    if (this.localScreenStream !== null) return this.localScreenStream;
    if (this.room === null) return null;
    const screenPub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (screenPub?.track?.mediaStreamTrack) return new MediaStream([screenPub.track.mediaStreamTrack]);
    return null;
  }

  /** Get a remote participant's video MediaStream by userId and track type. Returns null if not available. */
  getRemoteVideoStream(userId: number, type: "camera" | "screenshare"): MediaStream | null {
    if (this.room === null) return null;
    const participant = this.room.getParticipantByIdentity(`user-${userId}`);
    if (participant === undefined) return null;
    // Self-guard: don't return local participant's stream via this method
    if (participant === this.room.localParticipant) return null;
    const source = type === "screenshare" ? Track.Source.ScreenShare : Track.Source.Camera;
    const pub = participant.getTrackPublication(source);
    if (pub?.track?.mediaStreamTrack) return new MediaStream([pub.track.mediaStreamTrack]);
    return null;
  }

  getRoom(): Room | null {
    return this.room;
  }

  getSessionDebugInfo(): Record<string, unknown> {
    if (this.room === null) {
      return { hasRoom: false, hasRNNoiseProcessor: false, currentChannelId: this.currentChannelId };
    }
    const remoteParticipants = [...this.room.remoteParticipants.values()].map((p) => {
      const userId = parseUserId(p.identity);
      return {
        identity: p.identity,
        userId,
        volume: p.getVolume(),
        effectiveVolume: this.getEffectiveVolume(userId),
        tracks: [...p.trackPublications.values()].map((pub) => ({
          sid: pub.trackSid, source: pub.source, kind: pub.kind,
          subscribed: pub.isSubscribed, enabled: pub.isEnabled,
        })),
      };
    });
    const localTracks = [...this.room.localParticipant.trackPublications.values()].map((pub) => ({
      sid: pub.trackSid, source: pub.source, kind: pub.kind, isMuted: pub.isMuted,
    }));
    return {
      hasRoom: true, roomName: this.room.name, roomState: this.room.state,
      hasRNNoiseProcessor: this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.getProcessor() !== undefined,
      currentChannelId: this.currentChannelId,
      outputVolumeMultiplier: this.outputVolumeMultiplier,
      audioPipelineActive: this._audioPipeline.isActive,
      audioPipelineGain: this._audioPipeline.gainValue,
      audioPipelineCtxState: this._audioPipeline.ctxState,
      vadGated: this._audioPipeline.isVadGated,
      currentInputGain: this._audioPipeline.inputGain,
      localParticipant: this.room.localParticipant.identity, localTracks,
      remoteParticipants,
      iceConnectionState: this.getIceConnectionState(),
    };
  }

  /** Log ICE connection details for debugging cross-network voice issues. */
  private logIceConnectionInfo(): void {
    if (this.room === null) return;
    // Access the underlying RTCPeerConnection via LiveKit's engine.
    // LiveKit exposes the PeerConnection via room.engine.subscriber/publisher.
    try {
      const engine = (this.room as unknown as Record<string, unknown>).engine as Record<string, unknown> | undefined;
      if (!engine) return;

      const subscriber = engine.subscriber as Record<string, unknown> | undefined;
      const publisher = engine.publisher as Record<string, unknown> | undefined;
      const pcs: Array<{ label: string; pc: RTCPeerConnection }> = [];
      if (subscriber?.pc) pcs.push({ label: "subscriber", pc: subscriber.pc as RTCPeerConnection });
      if (publisher?.pc) pcs.push({ label: "publisher", pc: publisher.pc as RTCPeerConnection });

      for (const { label, pc } of pcs) {
        log.info(`ICE ${label} connection state`, {
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          connectionState: pc.connectionState,
          signalingState: pc.signalingState,
        });

        // Log selected candidate pair
        pc.getStats().then((stats) => {
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded") {
              const localId = report.localCandidateId;
              const remoteId = report.remoteCandidateId;
              let localType = "unknown";
              let remoteType = "unknown";
              let localProtocol = "unknown";

              stats.forEach((s) => {
                if (s.id === localId && s.type === "local-candidate") {
                  localType = s.candidateType ?? "unknown";
                  localProtocol = s.protocol ?? "unknown";
                }
                if (s.id === remoteId && s.type === "remote-candidate") {
                  remoteType = s.candidateType ?? "unknown";
                }
              });

              log.info(`ICE ${label} selected candidate pair`, {
                localType,
                remoteType,
                localProtocol,
              });
            }
          });
        }).catch((err) => {
          log.debug("Failed to get ICE stats", { error: String(err) });
        });
      }
    } catch (err) {
      log.debug("Failed to access ICE connection info", { error: String(err) });
    }
  }

  /** Get ICE connection state summary for debug panel. */
  private getIceConnectionState(): Record<string, unknown> | null {
    if (this.room === null) return null;
    try {
      const engine = (this.room as unknown as Record<string, unknown>).engine as Record<string, unknown> | undefined;
      if (!engine) return null;
      const subscriber = engine.subscriber as Record<string, unknown> | undefined;
      const publisher = engine.publisher as Record<string, unknown> | undefined;
      const result: Record<string, unknown> = {};
      if (subscriber?.pc) {
        const pc = subscriber.pc as RTCPeerConnection;
        result.subscriber = {
          iceConnectionState: pc.iceConnectionState,
          connectionState: pc.connectionState,
        };
      }
      if (publisher?.pc) {
        const pc = publisher.pc as RTCPeerConnection;
        result.publisher = {
          iceConnectionState: pc.iceConnectionState,
          connectionState: pc.connectionState,
        };
      }
      return result;
    } catch {
      return null;
    }
  }
}

// --- Singleton instance + re-exported bound methods ---

const session = new LiveKitSession();

// Expose debug info on window under __outcome namespace for DevTools console access
// Usage: JSON.stringify(__outcome.lkDebug(), null, 2)
const outcomeNs = ((window as unknown as Record<string, unknown>).__outcome ??= {}) as Record<string, unknown>;
outcomeNs.lkDebug = session.getSessionDebugInfo.bind(session);

/** Create the AudioContext while a click is still being handled — see AudioPipeline.primeContext. */
export const primeVoiceContext = (): void => session.audioPipeline.primeContext();
export const setWsClient = session.setWsClient.bind(session);
export const setServerHost = session.setServerHost.bind(session);
export const setOnError = session.setOnError.bind(session);
export const clearOnError = session.clearOnError.bind(session);
export const setOnRemoteVideo = session.setOnRemoteVideo.bind(session);
export const setOnRemoteVideoRemoved = session.setOnRemoteVideoRemoved.bind(session);
export const clearOnRemoteVideo = session.clearOnRemoteVideo.bind(session);
export const handleVoiceToken = session.handleVoiceToken.bind(session);
export const leaveVoice = session.leaveVoice.bind(session);
export const retryMicPermission = session.retryMicPermission.bind(session);
export const unlockAudio = session.unlockAudio.bind(session);
export const cleanupAll = session.cleanupAll.bind(session);
export const setMuted = session.setMuted.bind(session);
export const setDeafened = session.setDeafened.bind(session);
export const enableCamera = session.enableCamera.bind(session);
export const disableCamera = session.disableCamera.bind(session);
export const enableScreenshare = session.enableScreenshare.bind(session);
export const disableScreenshare = session.disableScreenshare.bind(session);
export const switchInputDevice = session.switchInputDevice.bind(session);
export const switchOutputDevice = session.switchOutputDevice.bind(session);
export const setUserVolume = session.setUserVolume.bind(session);
export const getUserVolume = session.getUserVolume.bind(session);
export const setAudioSmoothing = session.setAudioSmoothing.bind(session);
export const setInputVolume = session.setInputVolume.bind(session);
export const setOutputVolume = session.setOutputVolume.bind(session);
export const setVoiceSensitivity = session.setVoiceSensitivity.bind(session);
export const reapplyAudioProcessing = session.reapplyAudioProcessing.bind(session);

/** Which noise filter is on the microphone right now, or null when not in a call. */
export function activeNoiseEngine(): string | null {
  return session.audioPipeline.activeEngine;
}
export const getLocalCameraStream = session.getLocalCameraStream.bind(session);
export const getLocalScreenshareStream = session.getLocalScreenshareStream.bind(session);
export const getRemoteVideoStream = session.getRemoteVideoStream.bind(session);
export const getSessionDebugInfo = session.getSessionDebugInfo.bind(session);
export const setScreenshareAudioVolume = session.setScreenshareAudioVolume.bind(session);
export const muteScreenshareAudio = session.muteScreenshareAudio.bind(session);
export const getScreenshareAudioMuted = session.getScreenshareAudioMuted.bind(session);

export function getRoomForStats(): Room | null {
  return session.getRoom();
}
