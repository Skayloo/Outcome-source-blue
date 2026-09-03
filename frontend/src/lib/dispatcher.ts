// Step 2.26 — WebSocket Dispatcher
// Wires WS client events to store updates.
// Each server message type maps to one or more store actions.

import type { WsClient } from "./ws";
import { authStore, setAuth, clearAuth, markSessionInvalid } from "@stores/auth.store";
import { setTransientError, showToast, uiStore } from "@stores/ui.store";
import { t } from "@lib/i18n";
import {
  setChannels,
  setRoles,
  setActiveChannel,
  addChannel,
  updateChannel,
  removeChannel,
  incrementUnread,
  clearUnread,
  advanceOthersRead,
  takePendingChannel,
} from "@stores/channels.store";
import { channelsStore } from "@stores/channels.store";
import {
  addMessage,
  editMessage,
  deleteMessage,
  markUserMessagesDeleted,
  updateReaction,
  confirmSend,
} from "@stores/messages.store";
import {
  setMembers,
  addMember,
  removeMember,
  updateMemberRole,
  updatePresence,
  setTyping,
  clearTyping,
} from "@stores/members.store";
import {
  voiceStore,
  setVoiceStates,
  updateVoiceState,
  removeVoiceUser,
  setVoiceConfig,
  setSpeakers,
  joinVoiceChannel,
  leaveVoiceChannel,
} from "@stores/voice.store";
import { playVoiceCue, startCallRingtone, stopCallRingtone, joinVoice, leaveVoiceNow, leaveVoiceLocal } from "@lib/voice";
import { addIncomingRequest, promoteToFriend, dropFriend } from "@stores/friends.store";
import {
  setIncomingCall,
  clearIncomingCall,
  clearOutgoingCall,
  setActiveCall,
} from "@stores/call.store";
import {
  dmStore,
  setDmChannels,
  addDmChannel,
  removeDmChannel,
  updateDmLastMessage,
  updateDmLastMessagePreview,
  clearDmUnread,
  advancePeerRead,
} from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { setMutedChannels, isChannelMuted } from "@stores/mutes.store";
import { markListened, markListenedByOthers } from "@stores/listened.store";
import type { DmChannelPayload } from "./types";
import { handleVoiceToken } from "@lib/livekitSession";
import { api, wsSend } from "./services";
import { enterDmView } from "./dm";
import { notifyIncomingMessage, notifyIncomingCall, stopTitleFlash, closeCallNotification } from "./notifications";
import { createLogger } from "./logger";
import { ServerMessageType as S } from "./protocolTypes";

const log = createLogger("dispatcher");

/** Map a server DM channel payload to the client DmChannel type. */
/** Fetch the user's DM channel list into the store. Called after auth (the READY payload
 *  does not carry DMs) and lazily when a message arrives for an unknown channel — which is
 *  how a brand-new DM opened by the OTHER side becomes visible. */
let dmRefetchInFlight = false;
export async function loadDmChannels(): Promise<void> {
  if (dmRefetchInFlight) return;
  dmRefetchInFlight = true;
  try {
    const res = await api.getDmChannels();
    setDmChannels(res.dm_channels.map(mapDmPayload));
  } catch (err) {
    log.warn("Failed to load DM channels", err);
  } finally {
    dmRefetchInFlight = false;
  }
}

function mapDmPayload(p: DmChannelPayload): DmChannel {
  return {
    channelId: p.channel_id,
    recipient: {
      id: p.recipient.id,
      username: p.recipient.username,
      avatar: p.recipient.avatar,
      status: p.recipient.status,
    },
    lastMessageId: p.last_message_id,
    lastMessage: p.last_message,
    lastMessageAt: p.last_message_at,
    unreadCount: p.unread_count,
    peerReadUpTo: p.peer_read_up_to ?? 0,
  };
}

/** Unsubscribe all listeners. */
export type DispatcherCleanup = () => void;

/**
 * Wire a WsClient to all domain stores.
 * Returns a cleanup function that removes all listeners.
 */
export function wireDispatcher(ws: WsClient): DispatcherCleanup {
  const unsubs: Array<() => void> = [];

  // ── Auth ──────────────────────────────────────────────

  unsubs.push(
    ws.on(S.AUTH_OK, (payload) => {
      setAuth(
        authStore.getState().token ?? "",
        payload.user,
        payload.server_name,
        payload.motd,
      );
    }),
  );

  unsubs.push(
    ws.on(S.AUTH_ERROR, (payload) => {
      log.error("Auth failed", { message: payload.message });
      setTransientError(payload.message);
      clearAuth();
      // A restored session the server refused (expired/revoked token): stop showing the
      // boot splash and fall through to the login form.
      markSessionInvalid();
    }),
  );

  // ── Ready (initial state dump) ────────────────────────

  unsubs.push(
    ws.on(S.READY, (payload) => {
      setChannels(payload.channels);
      setRoles(payload.roles ?? []);
      setMembers(payload.members);
      setVoiceStates(payload.voice_states);

      // Re-announce voice presence after a WS reconnect: the server drops our voice_states
      // row the moment the socket dies while the LiveKit media session keeps playing, which
      // turns us into a ghost — audible, but absent from every roster. Idempotent re-join
      // restores the row (and skips the media reconnect via the session-already-live guard).
      const inVoice = voiceStore.select((s) => s.currentChannelId);
      if (inVoice !== null && !payload.voice_states.some(
        (v) => v.channel_id === inVoice && v.user_id === (authStore.getState().user?.id ?? 0),
      )) {
        wsSend("voice_join", { channel_id: inVoice });
      }

      // A cross-server jump (e.g. voice dock "open" from another space) asked for a specific
      // channel — honor it if this scoped READY actually carries it; else fall back to the
      // first text channel when nothing is active.
      const pending = takePendingChannel();
      const currentActive = channelsStore.select((s) => s.activeChannelId);
      if (pending !== null && payload.channels.some((ch) => ch.id === pending)) {
        setActiveChannel(pending);
      } else if (
        currentActive === null &&
        uiStore.getState().sidebarMode !== "dms" && // in Home/DM view, don't grab a server channel
        payload.channels.length > 0
      ) {
        const firstText = payload.channels.find((ch) => ch.type === "text");
        if (firstText !== undefined) {
          setActiveChannel(firstText.id);
        }
      }

      // Populate DM channels if present in the ready payload
      const dmPayloads = payload.dm_channels ?? [];
      if (dmPayloads.length > 0) {
        setDmChannels(dmPayloads.map(mapDmPayload));
      }

      setMutedChannels(payload.muted_channels ?? []);

      log.info("Ready payload applied", {
        channels: payload.channels.length,
        members: payload.members.length,
        voiceStates: payload.voice_states.length,
        dmChannels: dmPayloads.length,
      });
    }),
  );

  // ── DM Channels ─────────────────────────────────────

  unsubs.push(
    ws.on(S.DM_CHANNEL_OPEN, (payload) => {
      log.info("DM channel opened", { channelId: payload.channel_id });
      addDmChannel(mapDmPayload(payload));
    }),
  );

  unsubs.push(
    ws.on(S.DM_CHANNEL_CLOSE, (payload) => {
      log.info("DM channel closed", { channelId: payload.channel_id });
      removeDmChannel(payload.channel_id);
    }),
  );

  // ── Chat Messages ─────────────────────────────────────

  unsubs.push(
    ws.on(S.CHAT_MESSAGE, (payload) => {
      log.debug("chat_message received", {
        id: payload.id,
        channelId: payload.channel_id,
        user: payload.user.username,
      });
      addMessage(payload);
      // The author's message arrived — drop their lingering "is typing…" immediately.
      clearTyping(payload.channel_id, payload.user.id);
      const activeId = channelsStore.select(
        (s) => s.activeChannelId,
      );

      // Check if this is a DM channel and whether the message is from self.
      const dmChannels = dmStore.getState().channels;
      const isDm = dmChannels.some((c) => c.channelId === payload.channel_id);
      const currentUserId = authStore.getState().user?.id ?? null;
      const isOwnMessage = currentUserId !== null && payload.user.id === currentUserId;

      // Message for a channel we don't know at all → almost certainly a NEW DM the other
      // side just opened. Refetch the DM list so it appears in the sidebar with its unread.
      if (!isDm && !channelsStore.getState().channels.has(payload.channel_id)) {
        void loadDmChannels();
      }

      // Increment channel-level unread for non-active, non-own-message channels.
      // Skip during reconnection replay to avoid inflating counts — the
      // server's ready payload already contains accurate unread_count values.
      // DM channel IDs are not in channelsStore (they use dmStore), so
      // incrementUnread is a no-op for DMs, but the own-message guard is
      // applied here for defence-in-depth.
      if (payload.channel_id !== activeId && !isOwnMessage && !ws.isReplaying()) {
        incrementUnread(payload.channel_id);
      }

      // Update DM store last message if this message belongs to a DM channel.
      // Skip unread increment for own messages, currently focused DM, and replay.
      if (isDm) {
        const isDmActive = payload.channel_id === activeId;
        if (isOwnMessage || isDmActive || ws.isReplaying()) {
          // Update last message preview but don't increment unread count.
          updateDmLastMessagePreview(
            payload.channel_id,
            payload.id,
            payload.content,
            payload.timestamp,
          );
        } else {
          updateDmLastMessage(
            payload.channel_id,
            payload.id,
            payload.content,
            payload.timestamp,
          );
        }
      }

      // Fire desktop notification, taskbar flash, and sound — but never for our own
      // messages, never for the burst of missed messages replayed on reconnect, and
      // never for chats the user muted. A direct @mention CUTS THROUGH the mute.
      const myName = authStore.getState().user?.username;
      const mentioned = !isOwnMessage && !!myName &&
        new RegExp(`@${myName.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![\\w.\\-])`, "i").test(payload.content);
      if (!isOwnMessage && !ws.isReplaying() && (mentioned || !isChannelMuted(payload.channel_id))) {
        notifyIncomingMessage(payload, mentioned);
      }

      // The user is LOOKING at this channel — advance the server-side read marker so
      // the badge never lights up on their other devices.
      if (payload.channel_id === activeId && document.hasFocus() && !ws.isReplaying()) {
        wsSend("read", { channel_id: payload.channel_id });
      }
    }),
  );

  // A read marker moved. MINE (any device) → clear badges. Someone ELSE's → my sent
  // messages up to it flip to ✓✓.
  unsubs.push(
    ws.on(S.READ_STATE, (payload) => {
      const meId = authStore.getState().user?.id;
      if (payload.user_id === undefined || payload.user_id === meId) {
        clearUnread(payload.channel_id);
        clearDmUnread(payload.channel_id);
      } else {
        advanceOthersRead(payload.channel_id, payload.last_message_id);
        advancePeerRead(payload.channel_id, payload.last_message_id);
      }
    }),
  );

  // Played a voice message on another device — its unlistened dot goes out here too.
  unsubs.push(
    ws.on(S.VOICE_LISTENED, (payload) => {
      markListened(payload.attachment_id);
    }),
  );

  // Someone played MY voice message — the sender-side dot goes out (Telegram receipt).
  unsubs.push(
    ws.on(S.VOICE_LISTENED_PEER, (payload) => {
      markListenedByOthers(payload.attachment_id);
    }),
  );

  // This account joined voice from ANOTHER browser/device — hand the session over.
  unsubs.push(
    ws.on(S.VOICE_TAKEOVER, () => {
      if (voiceStore.getState().currentChannelId !== null) {
        leaveVoiceLocal();
        showToast(t("voice.takenOver"));
      }
    }),
  );

  unsubs.push(
    ws.on(S.CHAT_EDITED, (payload) => {
      editMessage(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHAT_DELETED, (payload) => {
      deleteMessage(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHAT_SEND_OK, (payload, id) => {
      if (id) {
        confirmSend(id, payload.message_id, payload.timestamp);
      }
    }),
  );

  // ── Reactions ───────────────────────────────────────────

  unsubs.push(
    ws.on(S.REACTION_UPDATE, (payload) => {
      const userId = authStore.getState().user?.id ?? 0;
      updateReaction(payload, userId);
    }),
  );

  // ── Typing ────────────────────────────────────────────

  unsubs.push(
    ws.on(S.TYPING, (payload) => {
      setTyping(payload.channel_id, payload.user_id);
    }),
  );

  // ── Presence ──────────────────────────────────────────

  unsubs.push(
    ws.on(S.PRESENCE, (payload) => {
      updatePresence(payload.user_id, payload.status);
    }),
  );

  // ── Channels ──────────────────────────────────────────

  unsubs.push(
    ws.on(S.CHANNEL_CREATE, (payload) => {
      addChannel(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHANNEL_UPDATE, (payload) => {
      updateChannel(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHANNEL_DELETE, (payload) => {
      // If the deleted channel is the active one, redirect to the first text channel.
      const activeId = channelsStore.select((s) => s.activeChannelId);
      removeChannel(payload.id);
      if (payload.id === activeId) {
        const remaining = channelsStore.select((s) => s.channels);
        const sorted = [...remaining.values()]
          .filter((ch) => ch.type === "text")
          .sort((a, b) => a.position - b.position);
        const firstTextId = sorted.length > 0 ? sorted[0]!.id : null;
        setActiveChannel(firstTextId);
        log.info("Active channel deleted, redirected", { deletedId: payload.id });
      }
    }),
  );

  // ── Members ───────────────────────────────────────────

  unsubs.push(
    ws.on(S.MEMBER_JOIN, (payload) => {
      log.info("Member joined", { userId: payload.user.id, username: payload.user.username });
      addMember(payload);
    }),
  );

  unsubs.push(
    ws.on(S.MEMBER_LEAVE, (payload) => {
      log.info("Member left", { userId: payload.user_id });
      removeMember(payload.user_id);
    }),
  );

  unsubs.push(
    ws.on(S.MEMBER_BAN, (payload) => {
      log.info("Member banned", { userId: payload.user_id });
      removeMember(payload.user_id);
    }),
  );

  unsubs.push(
    ws.on(S.MEMBER_DELETE, (payload) => {
      log.info("Member deleted account", { userId: payload.user_id });
      removeMember(payload.user_id);
      // Their messages are soft-deleted server-side; mirror it so replies show "Deleted message".
      markUserMessagesDeleted(payload.user_id);
    }),
  );

  unsubs.push(
    ws.on(S.MEMBER_UPDATE, (payload) => {
      log.info("Member role updated", { userId: payload.user_id, role: payload.role });
      updateMemberRole(payload.user_id, payload.role);
    }),
  );

  // ── Friends ───────────────────────────────────────────

  unsubs.push(
    ws.on(S.FRIEND_REQUEST, (payload) => {
      log.info("Friend request", { from: payload.from.id });
      addIncomingRequest(payload.from);
      showToast(t("friends.requestFrom", { name: payload.from.username }), "info");
    }),
  );

  unsubs.push(
    ws.on(S.FRIEND_ACCEPTED, (payload) => {
      log.info("Friend accepted", { user: payload.user.id });
      promoteToFriend(payload.user);
      showToast(t("friends.nowFriends", { name: payload.user.username }), "success");
    }),
  );

  unsubs.push(
    ws.on(S.FRIEND_REMOVED, (payload) => {
      dropFriend(payload.user_id);
    }),
  );

  // ── Calls (1-on-1) ────────────────────────────────────

  unsubs.push(
    ws.on(S.CALL_INCOMING, (payload) => {
      log.info("Incoming call", { from: payload.caller.id });
      setIncomingCall({
        callerId: payload.caller.id,
        callerName: payload.caller.username,
        callerAvatar: payload.caller.avatar,
        channelId: payload.channel_id,
      });
      startCallRingtone();
      // OS-level alert when the tab/window isn't focused.
      notifyIncomingCall(payload.caller.username, payload.caller.avatar);
    }),
  );

  unsubs.push(
    ws.on(S.CALL_ACCEPTED, (payload) => {
      // Callee answered — stop the ringback and join the DM voice room (Home view).
      stopCallRingtone();
      clearOutgoingCall();
      setActiveCall(payload.channel_id);
      enterDmView();
      setActiveChannel(payload.channel_id);
      joinVoice(payload.channel_id);
    }),
  );

  unsubs.push(
    ws.on(S.CALL_DECLINED, (payload) => {
      stopCallRingtone();
      clearOutgoingCall();
      setTransientError(
        payload.reason === "offline" ? t("call.userOffline") : t("call.declined"),
      );
    }),
  );

  unsubs.push(
    ws.on(S.CALL_CANCELLED, () => {
      // Caller hung up before we answered.
      stopCallRingtone();
      stopTitleFlash();
      closeCallNotification();
      clearIncomingCall();
    }),
  );

  // ── Voice ─────────────────────────────────────────────

  unsubs.push(
    ws.on(S.VOICE_STATE, (payload) => {
      const currentUserId = authStore.getState().user?.id ?? 0;
      // Chime when ANOTHER user newly joins the voice channel I'm currently in.
      // voice_state also fires on mute/speaking changes, so only cue when the user
      // was not already present in my channel.
      const myChannel = voiceStore.select((s) => s.currentChannelId);
      if (
        payload.user_id !== currentUserId &&
        myChannel !== null &&
        payload.channel_id === myChannel
      ) {
        const alreadyHere = voiceStore.select(
          (s) => s.voiceUsers.get(myChannel)?.has(payload.user_id) ?? false,
        );
        if (!alreadyHere) playVoiceCue("join");
      }
      updateVoiceState(payload);
      // Follow our own voice_state only when THIS device already holds a session —
      // that's a legitimate channel move. When it doesn't, the frame is about the
      // account's OTHER device (join/mute/unmute from the PC would otherwise mark
      // this laptop "connected"). Our own fresh join sets the store in joinVoice().
      if (payload.user_id === currentUserId && myChannel !== null) {
        joinVoiceChannel(payload.channel_id);
      }
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_LEAVE, (payload) => {
      const currentUserId = authStore.getState().user?.id ?? 0;
      // Chime when ANOTHER user leaves the voice channel I'm currently in.
      const myChannel = voiceStore.select((s) => s.currentChannelId);
      if (
        payload.user_id !== currentUserId &&
        myChannel !== null &&
        payload.channel_id === myChannel &&
        voiceStore.select((s) => s.voiceUsers.get(myChannel)?.has(payload.user_id) ?? false)
      ) {
        playVoiceCue("leave");
      }
      removeVoiceUser(payload);
      // Clear local voice state if the current user was removed (kick/disconnect) — but ONLY
      // for the channel this device is actually in. Moving to another channel makes the server
      // announce our leave from the OLD one, and that frame reaches this connection too: acting
      // on it tore down the session we had just created, leaving the account present in the
      // roster with no live call anywhere.
      if (payload.user_id === currentUserId && payload.channel_id === myChannel) {
        leaveVoiceChannel();
      }
      // Phone semantics for 1-on-1 calls: when the peer hangs up, hang up too. A client
      // left sitting alone in the DM room stayed "in call" forever — and a stuck-in-room
      // callee swallowed every following ring, so second calls never rang.
      if (
        payload.user_id !== currentUserId &&
        myChannel !== null &&
        payload.channel_id === myChannel &&
        dmStore.getState().channels.some((d) => d.channelId === myChannel)
      ) {
        const others = voiceStore.select((s) => s.voiceUsers.get(myChannel));
        const alone = !others || [...others.keys()].every((id) => id === currentUserId);
        if (alone) {
          setActiveCall(null);
          leaveVoiceNow();
        }
      }
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_CONFIG, (payload) => {
      setVoiceConfig(payload);
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_SPEAKERS, (payload) => {
      setSpeakers(payload);
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_TOKEN, (payload) => {
      void handleVoiceToken(payload.token, payload.url, payload.channel_id, payload.direct_url);
    }),
  );


  // ── Server Events ─────────────────────────────────────

  unsubs.push(
    ws.on(S.SERVER_RESTART, (payload) => {
      log.warn("Server restarting", {
        reason: payload.reason,
        delaySeconds: payload.delay_seconds,
      });
      setTransientError(`Server is restarting: ${payload.reason ?? "maintenance"}`);
    }),
  );

  unsubs.push(
    ws.on(S.ERROR, (payload) => {
      log.error("Server error", {
        code: payload.code,
        message: payload.message,
      });
      if (payload.code === "BANNED") {
        // Banned users must not reconnect — show error and force logout.
        setTransientError(payload.message || "You have been banned");
        clearAuth();
        return;
      }
      if (payload.code === "CONTENT_BLOCKED") {
        // Its own code so this reads as a verdict on the WORDS. The server's English text names
        // the term it matched, which is useful in a log and wrong to put in front of a user.
        setTransientError(t("chat.contentBlocked"));
        return;
      }
      if (payload.code === "RATE_LIMITED" || payload.code === "FORBIDDEN") {
        setTransientError(payload.message || "Server error");
      }
    }),
  );

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}
