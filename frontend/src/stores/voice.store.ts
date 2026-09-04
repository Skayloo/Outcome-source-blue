/**
 * Voice store — holds voice channel state, local audio controls, and per-user voice info.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type {
  ReadyVoiceState,
  VoiceStatePayload,
  VoiceLeavePayload,
  VoiceConfigPayload,
  VoiceSpeakersPayload,
} from "@lib/types";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { getActiveServerId } from "@stores/servers.store";

export interface VoiceUser {
  readonly userId: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking: boolean;
  readonly camera: boolean;
  readonly screenshare: boolean;
}

export interface VoiceConfig {
  readonly quality: string;
  readonly bitrate: number;
  readonly threshold_mode: string;
  readonly mixing_threshold: number;
  readonly top_speakers: number;
  readonly max_users: number;
}

export interface VoiceState {
  readonly currentChannelId: number | null;
  /** Server that owns the connected voice channel — for the rail's "in voice here" dot. */
  readonly connectedServerId: number | null;
  readonly voiceUsers: ReadonlyMap<number, ReadonlyMap<number, VoiceUser>>; // channelId -> userId -> VoiceUser
  readonly voiceConfigs: ReadonlyMap<number, VoiceConfig>; // channelId -> VoiceConfig
  readonly localMuted: boolean;
  readonly localDeafened: boolean;
  readonly localCamera: boolean;
  readonly localScreenshare: boolean;
  /** Epoch ms when the local user joined the current voice channel (for elapsed timer). */
  readonly joinedAt: number | null;
  /** True when joined in listen-only mode (mic permission denied or no mic found). */
  readonly listenOnly: boolean;
  /** SFU-reported connection quality per participant: userId → excellent|good|poor|lost. */
  readonly connQuality: ReadonlyMap<number, string>;
  /** Users whose incoming audio rides an enlarged jitter buffer (see setAudioSmoothing). */
  readonly smoothedAudio: ReadonlySet<number>;
  /** How media actually reaches the SFU: "udp" | "tcp" | "relay", null until measured. A
   *  carrier that blocks UDP quietly downgrades the call to TCP, which is what "voice is bad
   *  on mobile" usually turns out to be — so it is visible rather than guessed at. */
  readonly transport: string | null;
  /** The browser refuses to play audio until the user gestures (mobile autoplay policy). */
  readonly audioBlocked: boolean;
  /** Raised hands: userId → the moment it went up, so a room can be worked in the order people
   *  asked. Kept in the store rather than a component because a hand outlives the render that
   *  showed it, and because the source of truth is LiveKit, not React. */
  readonly hands: ReadonlyMap<number, number>;
}

const INITIAL_STATE: VoiceState = {
  currentChannelId: null,
  connectedServerId: null,
  hands: new Map(),
  voiceUsers: new Map(),
  voiceConfigs: new Map(),
  localMuted: false,
  localDeafened: false,
  localCamera: false,
  localScreenshare: false,
  joinedAt: null,
  listenOnly: false,
  connQuality: new Map(),
  smoothedAudio: new Set(),
  transport: null,
  audioBlocked: false,
};

export const voiceStore = createStore<VoiceState>(INITIAL_STATE, true);

/** Reset voice store to initial state (e.g. on logout). */
export function resetVoiceStore(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    connectedServerId: null,
    hands: new Map(),
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    connQuality: new Map(),
    smoothedAudio: new Set(),
    transport: null,
    audioBlocked: false,
  }));
}

/** Record the SFU's connection-quality verdict for one participant ("unknown" clears it). */
export function setConnQuality(userId: number, quality: string): void {
  voiceStore.setState((prev) => {
    if ((prev.connQuality.get(userId) ?? "unknown") === quality) return prev;
    const next = new Map(prev.connQuality);
    if (quality === "unknown") next.delete(userId);
    else next.set(userId, quality);
    return { ...prev, connQuality: next };
  });
}

/** Mark a user's incoming audio as smoothed (UI checkmark; the buffer itself lives in LiveKit). */
export function setAudioSmoothed(userId: number, smoothed: boolean): void {
  voiceStore.setState((prev) => {
    if (prev.smoothedAudio.has(userId) === smoothed) return prev;
    const next = new Set(prev.smoothedAudio);
    if (smoothed) next.add(userId);
    else next.delete(userId);
    return { ...prev, smoothedAudio: next };
  });
}

/** Bulk set voice states from the ready payload. */
export function setVoiceStates(states: readonly ReadyVoiceState[]): void {
  const channelMap = new Map<number, Map<number, VoiceUser>>();

  const prevChannels = voiceStore.getState().voiceUsers;
  for (const vs of states) {
    let userMap = channelMap.get(vs.channel_id);
    if (!userMap) {
      userMap = new Map();
      channelMap.set(vs.channel_id, userMap);
    }
    // Username/avatar: prefer the READY payload's own username, then the roster, then the
    // PREVIOUS store entry — after switch_server the roster holds the NEW server's members,
    // so participants of a still-active call on the old server would otherwise blank out.
    const member = membersStore.getState().members.get(vs.user_id);
    const prevEntry = prevChannels.get(vs.channel_id)?.get(vs.user_id);
    userMap.set(vs.user_id, {
      userId: vs.user_id,
      username: vs.username ?? member?.username ?? prevEntry?.username ?? "",
      avatar: member?.avatar ?? prevEntry?.avatar ?? null,
      muted: vs.muted,
      deafened: vs.deafened,
      speaking: vs.speaking ?? false,
      camera: vs.camera ?? false,
      screenshare: vs.screenshare ?? false,
    });
  }

  // Guests in the channel WE are connected to are mirrored live from our own LiveKit connection
  // (seeded on join, removed on ParticipantDisconnected) — a READY snapshot must not erase them,
  // or every WS reconnect (constant on mobile) wiped guests out from under a member in the call.
  // Other channels' guests now COME from the READY snapshot itself (the server tracks them via
  // LiveKit webhooks), so those take the snapshot as truth — carrying them over here would keep
  // a stale guest forever if they left while our WS was down.
  const connectedId = voiceStore.getState().currentChannelId;
  if (connectedId != null) {
    const prevUsers = prevChannels.get(connectedId);
    if (prevUsers) {
      let userMap = channelMap.get(connectedId);
      if (!userMap) { userMap = new Map(); channelMap.set(connectedId, userMap); }
      for (const [uid, u] of prevUsers) {
        if (uid < 0 && !userMap.has(uid)) userMap.set(uid, u);
      }
    }
  }

  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: channelMap,
    // currentChannelId means "THIS device has the live media session" and only
    // joinVoice()/leaveVoiceChannel() may move it. Seeing ourselves in the READY
    // snapshot proves nothing about this device: the account may be in the call from
    // the PC while the laptop merely switched onto this server — adopting the channel
    // here showed "voice connected" on a device with no session at all.
    currentChannelId: prev.currentChannelId,
  }));
}

/** Update or add a user's voice state from a voice_state event. */
export function updateVoiceState(payload: VoiceStatePayload): void {
  voiceStore.setState((prev) => {
    const nextChannels = new Map(prev.voiceUsers);
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    const nextUsers = new Map(existingChannel ?? []);

    nextUsers.set(payload.user_id, {
      userId: payload.user_id,
      username: payload.username,
      avatar: membersStore.getState().members.get(payload.user_id)?.avatar ?? existingChannel?.get(payload.user_id)?.avatar ?? null,
      muted: payload.muted,
      deafened: payload.deafened,
      speaking: payload.speaking,
      camera: payload.camera,
      screenshare: payload.screenshare,
    });

    nextChannels.set(payload.channel_id, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Remove a user from a voice channel. */
export function removeVoiceUser(payload: VoiceLeavePayload): void {
  voiceStore.setState((prev) => {
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    if (!existingChannel || !existingChannel.has(payload.user_id)) return prev;

    const nextChannels = new Map(prev.voiceUsers);
    const nextUsers = new Map(existingChannel);
    nextUsers.delete(payload.user_id);

    if (nextUsers.size === 0) {
      nextChannels.delete(payload.channel_id);
    } else {
      nextChannels.set(payload.channel_id, nextUsers);
    }

    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Set the current voice channel (local join) and record the join timestamp.
 *  Only resets joinedAt if the user is joining a different channel (or was not in one). */
export function joinVoiceChannel(channelId: number): void {
  voiceStore.setState((prev) => {
    // Already in this channel — don't reset the timer
    if (prev.currentChannelId === channelId) return prev;
    return {
      ...prev,
      currentChannelId: channelId,
      connectedServerId: getActiveServerId(),
      joinedAt: Date.now(),
    };
  });
}

/** The server that owns the connected voice channel (for the rail's "in voice" dot). */
export function getConnectedServerId(): number | null {
  return voiceStore.select((s) => s.connectedServerId);
}

/**
 * Clear the current voice channel and remove current user from voice users.
 * `keepPresence`: the session moved to ANOTHER device of the same account — the server
 * still holds us in that channel, so drop the local session but leave the roster row
 * standing. Otherwise the user vanishes from a call they are still in.
 */
export function leaveVoiceChannel(keepPresence = false): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  voiceStore.setState((prev) => {
    const cleared = { ...prev, currentChannelId: null, connectedServerId: null, joinedAt: null, hands: new Map<number, number>() };
    const channelId = prev.currentChannelId;
    if (keepPresence || channelId === null || currentUserId === 0) return cleared;
    const existingChannel = prev.voiceUsers.get(channelId);
    if (!existingChannel || !existingChannel.has(currentUserId)) return cleared;
    const nextChannels = new Map(prev.voiceUsers);
    const nextUsers = new Map(existingChannel);
    nextUsers.delete(currentUserId);
    if (nextUsers.size === 0) {
      nextChannels.delete(channelId);
    } else {
      nextChannels.set(channelId, nextUsers);
    }
    return { ...cleared, voiceUsers: nextChannels };
  });
}

/** Toggle local mute state. */
/** Replace the whole set — the truth is LiveKit's participant attributes, and diffing a
 *  six-entry map is not worth the bugs it would buy. */
export function setRaisedHands(hands: ReadonlyMap<number, number>): void {
  voiceStore.setState((prev) => {
    if (prev.hands.size === hands.size && [...hands].every(([k, v]) => prev.hands.get(k) === v)) return prev;
    return { ...prev, hands };
  });
}

export function setVoiceTransport(transport: string | null): void {
  voiceStore.setState((prev) => (prev.transport === transport ? prev : { ...prev, transport }));
}

export function setAudioBlocked(blocked: boolean): void {
  voiceStore.setState((prev) => (prev.audioBlocked === blocked ? prev : { ...prev, audioBlocked: blocked }));
}

export function setLocalMuted(muted: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localMuted: muted,
  }));
}

/** Toggle local deafen state. */
export function setLocalDeafened(deafened: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localDeafened: deafened,
  }));
}

/** Toggle local camera state. */
export function setLocalCamera(enabled: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localCamera: enabled,
  }));
}

/** Toggle local screenshare state. */
export function setLocalScreenshare(enabled: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localScreenshare: enabled,
  }));
}

/** Set listen-only mode (mic permission denied or no mic found). */
export function setListenOnly(listenOnly: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    listenOnly,
  }));
}

/** Set the LOCAL user's speaking state (driven by the client-side mic level monitor).
 *  This is the sole writer of the current user's `speaking` flag — see setSpeakers. */
export function setLocalSpeaking(speaking: boolean): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  if (currentUserId === 0) return;
  voiceStore.setState((prev) => {
    const channelId = prev.currentChannelId;
    if (channelId === null) return prev;
    const channelUsers = prev.voiceUsers.get(channelId);
    if (!channelUsers) return prev;
    const user = channelUsers.get(currentUserId);
    if (!user || user.speaking === speaking) return prev;
    const nextUsers = new Map(channelUsers);
    nextUsers.set(currentUserId, { ...user, speaking });
    const nextChannels = new Map(prev.voiceUsers);
    nextChannels.set(channelId, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Store voice config for a channel from a voice_config event. */
export function setVoiceConfig(payload: VoiceConfigPayload): void {
  voiceStore.setState((prev) => {
    const nextConfigs = new Map(prev.voiceConfigs);
    nextConfigs.set(payload.channel_id, {
      quality: payload.quality,
      bitrate: payload.bitrate,
      threshold_mode: payload.threshold_mode,
      mixing_threshold: payload.mixing_threshold,
      top_speakers: payload.top_speakers,
      max_users: payload.max_users,
    });
    return { ...prev, voiceConfigs: nextConfigs };
  });
}

/** Update speaking state for REMOTE users from a voice_speakers event or LiveKit's
 *  ActiveSpeakersChanged. The LOCAL user is deliberately left untouched here — their
 *  speaking is owned exclusively by the client-side mic monitor (setLocalSpeaking),
 *  because the SFU's active-speaker list does not reliably include the local
 *  participant. Letting both write `speaking` made them clobber each other. */
export function setSpeakers(payload: VoiceSpeakersPayload): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  voiceStore.setState((prev) => {
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    if (!existingChannel) return prev;

    const speakerSet = new Set(payload.speakers);
    const nextUsers = new Map<number, VoiceUser>();
    let changed = false;

    for (const [userId, user] of existingChannel) {
      if (userId === currentUserId) {
        // Local speaking is driven by the mic monitor — never overwrite it from here.
        nextUsers.set(userId, user);
        continue;
      }
      const isSpeaking = speakerSet.has(userId);
      if (user.speaking !== isSpeaking) {
        nextUsers.set(userId, { ...user, speaking: isSpeaking });
        changed = true;
      } else {
        nextUsers.set(userId, user);
      }
    }

    // ActiveSpeakersChanged fires continuously during speech — bail without allocating
    // new state (and waking subscribers) when no flag actually flipped.
    if (!changed) return prev;

    const nextChannels = new Map(prev.voiceUsers);
    nextChannels.set(payload.channel_id, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Selector: get all voice users in a specific channel. */
export function getChannelVoiceUsers(channelId: number): readonly VoiceUser[] {
  return voiceStore.select((s) => {
    const channelUsers = s.voiceUsers.get(channelId);
    if (!channelUsers) return [];
    return Array.from(channelUsers.values());
  });
}
