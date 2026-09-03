// =============================================================================
// Outcome Protocol Types
// All WebSocket message types, REST response types, and permission definitions.
// Source of truth: PROTOCOL.md, API.md, SCHEMA.md
// =============================================================================

// -----------------------------------------------------------------------------
// Common / Shared Types
// -----------------------------------------------------------------------------

/** Status values allowed by the protocol. */
export type UserStatus = "online" | "idle" | "dnd" | "offline";

/** Channel types supported by the server. */
export type ChannelType = "text" | "voice" | "announcement" | "dm";

/** Voice quality presets. */
export type VoiceQuality = "low" | "medium" | "high";

/** Reaction action direction. */
export type ReactionAction = "add" | "remove";

/** WebSocket error codes returned by the server. */
export type WsErrorCode =
  | "BANNED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "SERVER_ERROR"
  | "CHANNEL_FULL"
  | "CONTENT_BLOCKED"
  | "VOICE_ERROR"
  | "VIDEO_LIMIT";

/** REST API error codes. */
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "TOO_LARGE"
  | "SERVER_ERROR"
  | "UNKNOWN";

// -----------------------------------------------------------------------------
// Embedded Objects (used inside payloads)
// -----------------------------------------------------------------------------

/** Minimal user object embedded in messages and member payloads. */
export interface MessageUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
}

/** User object with role, used in auth_ok and member_join. */
export interface UserWithRole extends MessageUser {
  readonly role: string;
  readonly totp_enabled?: boolean;
}

/** Attachment on a chat message. */
export interface Attachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
  /** Voice message: duration in ms + JSON string of amplitude peaks (see VoiceMessage). */
  readonly duration_ms?: number;
  readonly waveform?: string;
  /** REST history only: whether the requesting user has played this voice clip. */
  readonly listened?: boolean;
  /** REST history only: whether anyone ELSE has (sender-side dot). */
  readonly listened_by_others?: boolean;
}

/** Reaction summary on a REST message response. */
export interface ReactionSummary {
  readonly emoji: string;
  readonly count: number;
  readonly me: boolean;
}

// -----------------------------------------------------------------------------
// Ready Payload Nested Objects
// -----------------------------------------------------------------------------

/** Channel object in the ready payload. */
export interface ReadyChannel {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly position: number;
  readonly unread_count?: number;
  readonly last_message_id?: number;
  readonly read_by_others?: number;
}

/** Member object in the ready payload. */
export interface ReadyMember {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
  /** When the account was made. Absent from older servers — the profile omits the line. */
  readonly created_at?: string;
}

/** Voice state object in the ready payload. */
export interface ReadyVoiceState {
  readonly channel_id: number;
  readonly user_id: number;
  readonly username?: string;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking?: boolean;
  readonly camera?: boolean;
  readonly screenshare?: boolean;
}

/** Role object in the ready payload. */
export interface ReadyRole {
  readonly id: number;
  readonly name: string;
  readonly color: string | null;
  readonly permissions: number;
}

/** Full role record from the REST API (GET/POST/PATCH /api/v1/roles). */
export interface RoleResponse {
  readonly id: number;
  readonly name: string;
  readonly color: string | null;
  readonly permissions: number;
  readonly position: number;
  readonly is_default: boolean;
}

// -----------------------------------------------------------------------------
// Permission Bitfield (from SCHEMA.md)
// -----------------------------------------------------------------------------

export enum Permission {
  SEND_MESSAGES   = 0x1,
  READ_MESSAGES   = 0x2,
  ATTACH_FILES    = 0x20,
  ADD_REACTIONS   = 0x40,
  USE_SOUNDBOARD  = 0x100,
  CONNECT_VOICE   = 0x200,
  SPEAK_VOICE     = 0x400,
  USE_VIDEO       = 0x800,
  SHARE_SCREEN    = 0x1000,
  MANAGE_MESSAGES = 0x10000,
  MANAGE_CHANNELS = 0x20000,
  KICK_MEMBERS    = 0x40000,
  BAN_MEMBERS     = 0x80000,
  MUTE_MEMBERS    = 0x100000,
  MANAGE_ROLES    = 0x1000000,
  MANAGE_SERVER   = 0x2000000,
  MANAGE_INVITES  = 0x4000000,
  VIEW_AUDIT_LOG  = 0x8000000,
  ADMINISTRATOR   = 0x40000000,
}

// -----------------------------------------------------------------------------
// WebSocket Envelope
// -----------------------------------------------------------------------------

/** Generic WebSocket message envelope. */
export interface WsEnvelope<T> {
  readonly type: string;
  readonly id?: string;
  readonly payload: T;
}

// -----------------------------------------------------------------------------
// Server → Client Payloads
// -----------------------------------------------------------------------------

export interface AuthOkPayload {
  readonly user: UserWithRole;
  readonly server_name: string;
  readonly motd: string;
}

export interface AuthErrorPayload {
  readonly message: string;
}

export interface ReadyPayload {
  readonly channels: readonly ReadyChannel[];
  readonly members: readonly ReadyMember[];
  readonly voice_states: readonly ReadyVoiceState[];
  readonly roles: readonly ReadyRole[];
  readonly dm_channels?: readonly DmChannelPayload[];
  readonly muted_channels?: readonly number[];
}

export interface ChatMessagePayload {
  readonly id: number;
  readonly channel_id: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly reply_to: number | null;
  readonly forwarded_from?: string | null;
  readonly attachments: readonly Attachment[];
  readonly timestamp: string;
}

export interface ChatSendOkPayload {
  readonly message_id: number;
  readonly timestamp: string;
}

export interface ChatEditedPayload {
  readonly message_id: number;
  readonly channel_id: number;
  readonly content: string;
  readonly edited_at: string;
}

export interface ChatDeletedPayload {
  readonly message_id: number;
  readonly channel_id: number;
  /** DMs: the row was removed server-side, so drop the message instead of tombstoning it. */
  readonly purged?: boolean;
}

export interface ReactionUpdatePayload {
  readonly message_id: number;
  readonly channel_id: number;
  readonly emoji: string;
  readonly user_id: number;
  readonly action: ReactionAction;
}

export interface TypingPayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly username: string;
}

export interface PresencePayload {
  readonly user_id: number;
  readonly status: UserStatus;
}

export interface ChannelCreatePayload {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly position: number;
}

export interface ChannelUpdatePayload {
  readonly id: number;
  readonly name?: string;
  readonly position?: number;
}

export interface ChannelDeletePayload {
  readonly id: number;
}

export interface VoiceStatePayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly username: string;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking: boolean;
  readonly camera: boolean;
  readonly screenshare: boolean;
}

export interface VoiceLeavePayload {
  readonly channel_id: number;
  readonly user_id: number;
}

/** CRITICAL: uses threshold_mode, NOT mode. */
export interface VoiceConfigPayload {
  readonly channel_id: number;
  readonly quality: VoiceQuality;
  readonly bitrate: number;
  readonly threshold_mode: string;
  readonly mixing_threshold: number;
  readonly top_speakers: number;
  readonly max_users: number;
}

/** CRITICAL: uses threshold_mode, NOT mode. */
export interface VoiceSpeakersPayload {
  readonly channel_id: number;
  readonly speakers: readonly number[];
  readonly threshold_mode?: string;
}

export interface VoiceTokenPayload {
  readonly channel_id: number;
  readonly token: string;
  readonly url: string;
  readonly direct_url?: string;
  /** Shared room key for a guest-linked channel (base64). Present → use it directly instead of the
   *  WS key exchange, so members and keyless guests share one key. Absent → ordinary exchange. */
}

export interface MemberJoinPayload {
  readonly user: UserWithRole;
}

export interface MemberLeavePayload {
  readonly user_id: number;
}

export interface MemberUpdatePayload {
  readonly user_id: number;
  readonly role: string;
}

export interface MemberBanPayload {
  readonly user_id: number;
}

export interface MemberDeletePayload {
  readonly user_id: number;
}

// -----------------------------------------------------------------------------
// DM Payloads (Server → Client)
// -----------------------------------------------------------------------------

/** DM recipient object in DM channel payloads. */
export interface DmRecipient {
  readonly id: number;
  readonly username: string;
  readonly avatar: string;
  readonly status: string;
}

/** DM channel object in ready payload and dm_channel_open event. */
export interface DmChannelPayload {
  readonly channel_id: number;
  readonly recipient: DmRecipient;
  readonly last_message_id: number | null;
  readonly last_message: string;
  readonly last_message_at: string;
  readonly unread_count: number;
  readonly peer_read_up_to?: number;
}

export interface DmChannelOpenPayload {
  readonly channel_id: number;
  readonly recipient: DmRecipient;
  readonly last_message_id: number | null;
  readonly last_message: string;
  readonly last_message_at: string;
  readonly unread_count: number;
}

export interface DmChannelClosePayload {
  readonly channel_id: number;
}

export interface ServerRestartPayload {
  readonly reason: string;
  readonly delay_seconds: number;
}

export interface ErrorPayload {
  readonly code: WsErrorCode;
  readonly message: string;
}

// -----------------------------------------------------------------------------
// Client → Server Payloads
// -----------------------------------------------------------------------------

export interface AuthPayload {
  readonly token: string;
  readonly last_seq?: number;
  /** Scopes the READY payload to the active server (multi-server support). */
  readonly server_id?: number;
}

export interface ChatSendPayload {
  readonly channel_id: number;
  readonly content: string;
  readonly reply_to: number | null;
  readonly forwarded_from?: string | null;
  readonly attachments: readonly string[];
}

export interface ChatEditPayload {
  readonly message_id: number;
  readonly content: string;
}

export interface ChatDeletePayload {
  readonly message_id: number;
}

export interface ReactionAddPayload {
  readonly message_id: number;
  readonly emoji: string;
}

export interface ReactionRemovePayload {
  readonly message_id: number;
  readonly emoji: string;
}

export interface TypingStartPayload {
  readonly channel_id: number;
}

export interface ChannelFocusPayload {
  readonly channel_id: number;
}

export interface PresenceUpdatePayload {
  readonly status: UserStatus;
}

export interface VoiceJoinPayload {
  readonly channel_id: number;
}

/** Client → Server: leave current voice channel (no payload needed). */
export type VoiceLeaveClientPayload = Record<string, never>;

export interface VoiceMutePayload {
  readonly muted: boolean;
}

export interface VoiceDeafenPayload {
  readonly deafened: boolean;
}

export interface VoiceCameraPayload {
  readonly enabled: boolean;
}

export interface VoiceScreensharePayload {
  readonly enabled: boolean;
}

export interface SoundboardPlayPayload {
  readonly sound_id: string;
}

// -----------------------------------------------------------------------------
// Discriminated Union: Server → Client Messages
// -----------------------------------------------------------------------------

export interface ReadStatePayload {
  readonly channel_id: number;
  readonly user_id?: number;
  readonly last_message_id: number;
}

export interface VoiceListenedPayload {
  readonly attachment_id: string;
}

export interface VoiceTakeoverPayload {
  readonly channel_id: number;
}

export type ServerMessage =
  | (WsEnvelope<ReadStatePayload> & { readonly type: "read_state" })
  | (WsEnvelope<VoiceListenedPayload> & { readonly type: "voice_listened" })
  | (WsEnvelope<VoiceTakeoverPayload> & { readonly type: "voice_takeover" })
  | (WsEnvelope<VoiceListenedPayload> & { readonly type: "voice_listened_peer" })
  | (WsEnvelope<AuthOkPayload> & { readonly type: "auth_ok" })
  | (WsEnvelope<AuthErrorPayload> & { readonly type: "auth_error" })
  | (WsEnvelope<ReadyPayload> & { readonly type: "ready" })
  | (WsEnvelope<ChatMessagePayload> & { readonly type: "chat_message" })
  | (WsEnvelope<ChatSendOkPayload> & { readonly type: "chat_send_ok" })
  | (WsEnvelope<ChatEditedPayload> & { readonly type: "chat_edited" })
  | (WsEnvelope<ChatDeletedPayload> & { readonly type: "chat_deleted" })
  | (WsEnvelope<ReactionUpdatePayload> & { readonly type: "reaction_update" })
  | (WsEnvelope<TypingPayload> & { readonly type: "typing" })
  | (WsEnvelope<PresencePayload> & { readonly type: "presence" })
  | (WsEnvelope<ChannelCreatePayload> & { readonly type: "channel_create" })
  | (WsEnvelope<ChannelUpdatePayload> & { readonly type: "channel_update" })
  | (WsEnvelope<ChannelDeletePayload> & { readonly type: "channel_delete" })
  | (WsEnvelope<VoiceStatePayload> & { readonly type: "voice_state" })
  | (WsEnvelope<VoiceLeavePayload> & { readonly type: "voice_leave" })
  | (WsEnvelope<VoiceConfigPayload> & { readonly type: "voice_config" })
  | (WsEnvelope<VoiceSpeakersPayload> & { readonly type: "voice_speakers" })
  | (WsEnvelope<VoiceTokenPayload> & { readonly type: "voice_token" })
  | (WsEnvelope<MemberJoinPayload> & { readonly type: "member_join" })
  | (WsEnvelope<MemberLeavePayload> & { readonly type: "member_leave" })
  | (WsEnvelope<MemberUpdatePayload> & { readonly type: "member_update" })
  | (WsEnvelope<MemberBanPayload> & { readonly type: "member_ban" })
  | (WsEnvelope<MemberDeletePayload> & { readonly type: "member_delete" })
  | (WsEnvelope<FriendRequestPayload> & { readonly type: "friend_request" })
  | (WsEnvelope<FriendAcceptedPayload> & { readonly type: "friend_accepted" })
  | (WsEnvelope<FriendRemovedPayload> & { readonly type: "friend_removed" })
  | (WsEnvelope<CallIncomingPayload> & { readonly type: "call_incoming" })
  | (WsEnvelope<CallAcceptedPayload> & { readonly type: "call_accepted" })
  | (WsEnvelope<CallDeclinedPayload> & { readonly type: "call_declined" })
  | (WsEnvelope<CallCancelledPayload> & { readonly type: "call_cancelled" })
  | (WsEnvelope<DmChannelOpenPayload> & { readonly type: "dm_channel_open" })
  | (WsEnvelope<DmChannelClosePayload> & { readonly type: "dm_channel_close" })
  | (WsEnvelope<ServerRestartPayload> & { readonly type: "server_restart" })
  | (WsEnvelope<Record<string, never>> & { readonly type: "replay_done" })
  | (WsEnvelope<ErrorPayload> & { readonly type: "error" });

// -----------------------------------------------------------------------------
// Discriminated Union: Client → Server Messages
// -----------------------------------------------------------------------------

export type ClientMessage =
  | (WsEnvelope<AuthPayload> & { readonly type: "auth" })
  | (WsEnvelope<ChatSendPayload> & { readonly type: "chat_send" })
  | (WsEnvelope<ChatEditPayload> & { readonly type: "chat_edit" })
  | (WsEnvelope<ChatDeletePayload> & { readonly type: "chat_delete" })
  | (WsEnvelope<ReactionAddPayload> & { readonly type: "reaction_add" })
  | (WsEnvelope<ReactionRemovePayload> & { readonly type: "reaction_remove" })
  | (WsEnvelope<TypingStartPayload> & { readonly type: "typing_start" })
  | (WsEnvelope<ChannelFocusPayload> & { readonly type: "channel_focus" })
  | (WsEnvelope<PresenceUpdatePayload> & { readonly type: "presence_update" })
  | (WsEnvelope<VoiceJoinPayload> & { readonly type: "voice_join" })
  | (WsEnvelope<VoiceLeaveClientPayload> & { readonly type: "voice_leave" })
  | (WsEnvelope<VoiceMutePayload> & { readonly type: "voice_mute" })
  | (WsEnvelope<VoiceDeafenPayload> & { readonly type: "voice_deafen" })
  | (WsEnvelope<VoiceCameraPayload> & { readonly type: "voice_camera" })
  | (WsEnvelope<VoiceScreensharePayload> & { readonly type: "voice_screenshare" })
  | (WsEnvelope<SoundboardPlayPayload> & { readonly type: "soundboard_play" })
  | (WsEnvelope<{ readonly server_id: number }> & { readonly type: "switch_server" })
  | (WsEnvelope<Record<string, never>> & { readonly type: "voice_token_refresh" });

// -----------------------------------------------------------------------------
// REST API Response Types
// -----------------------------------------------------------------------------

/** POST /api/auth/login response. */
export interface AuthResponse {
  readonly token?: string;
  readonly partial_token?: string;
  readonly requires_2fa: boolean;
  /** Which 2FA method to complete when requires_2fa: "totp" or "email". */
  readonly two_factor_method?: string;
}

/** POST /api/auth/register response. With registration email-verification on, the account
 *  is NOT created yet: the server returns requires_email_verify + a partial token instead,
 *  and the client completes via POST /auth/register/verify. */
export interface RegisterResponse {
  readonly user?: { readonly id: number; readonly username: string };
  readonly token?: string;
  readonly requires_email_verify?: boolean;
  readonly partial_token?: string;
}

/** GET /api/health response. */
export interface HealthResponse {
  readonly status: string;
  readonly version: string;
  /** "red" (private build, E2EE clients) or "blue" (public self-hosted). The server defaults
   *  to blue, so a build that does not announce red must never be treated as private. */
  readonly edition?: string;
  readonly uptime: number;
  readonly online_users: number;
}

/** A server (guild) the current user is a member of. GET/POST /servers. */
export interface ServerDto {
  readonly id: number;
  readonly name: string;
  readonly owner_id: number;
  readonly icon: string | null;
}

/** A public server in the Explore directory. */
export interface PublicServerDto {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly icon: string | null;
  readonly member_count: number;
}

export interface ServerVisibilityDto {
  readonly is_public: boolean;
  readonly description: string;
}

/** Bug report statuses (mirror server BugReport constants). */
export type BugStatus = "new" | "in_progress" | "fixed";

/** A "Send To Developer" bug report. */
export interface BugReportDto {
  readonly id: number;
  readonly reporter_id: number;
  readonly reporter_name: string;
  readonly title: string;
  readonly description: string;
  readonly status: BugStatus;
  readonly attachments: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

/** Single channel object from REST API. */
export interface ChannelResponse {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly position: number;
}

/** Single message object from GET /api/channels/{id}/messages. */
export interface MessageResponse {
  readonly id: number;
  readonly channel_id: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly reply_to: number | null;
  readonly forwarded_from?: string | null;
  readonly attachments: readonly Attachment[];
  readonly reactions: readonly ReactionSummary[];
  readonly pinned: boolean;
  readonly edited_at: string | null;
  readonly deleted: boolean;
  readonly timestamp: string;
}

/** Paginated messages response. */
export interface MessagesResponse {
  readonly messages: readonly MessageResponse[];
  readonly has_more: boolean;
}

/** Member object from REST API. */
export interface MemberResponse {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
  /** False ⇒ an account made by a provider sign-in, with no password of its own — it
   *  cannot be signed into from the mobile app, which has no provider sign-in. Absent on
   *  older servers — treat that as true. */
  readonly password_set?: boolean;
  /** Show message text in push notifications, or only who sent it. Absent on older
   *  servers — treat that as true. */
  readonly push_preview?: boolean;
}

/** Search result item. */
export interface SearchResultItem {
  readonly message_id: number;
  readonly channel_id: number;
  readonly channel_name: string;
  readonly user: MessageUser;
  readonly content: string;
  readonly timestamp: string;
}

/** GET /api/search response. */
export interface SearchResponse {
  readonly results: readonly SearchResultItem[];
}

/** REST API error response body. */
export interface ApiError {
  readonly error: ApiErrorCode;
  readonly message: string;
}

/** Single emoji object from GET /api/emoji. */
export interface EmojiResponse {
  readonly id: number;
  readonly shortcode: string;
  readonly filename: string;
  readonly uploaded_by: number;
  readonly created_at: string;
}

/** Single sound object from GET /api/sounds. */
export interface SoundResponse {
  readonly id: number;
  readonly name: string;
  readonly filename: string;
  readonly duration_ms: number;
  readonly uploaded_by: number;
  readonly created_at: string;
}

/** Single invite object from GET/POST /api/invites. */
export interface InviteResponse {
  readonly id: number;
  readonly code: string;
  readonly url: string;
  readonly max_uses: number | null;
  readonly use_count?: number;
  readonly expires_at: string | null;
}

/** Single session object from GET /api/users/me/sessions. */
export interface SessionResponse {
  readonly id: number;
  readonly device: string | null;
  readonly ip_address: string | null;
  readonly created_at: string;
  readonly last_used: string;
  readonly expires_at: string;
  /** True for the session backing this very request — spared by both revoke paths. */
  readonly current: boolean;
}

/** Upload response from POST /api/uploads. */
export interface UploadResponse {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
  readonly duration_ms?: number;
  readonly waveform?: string;
}

/** GET /api/v1/dms response. */
export interface DmChannelsResponse {
  readonly dm_channels: readonly DmChannelPayload[];
}

/** POST /api/v1/dms response. */
export interface CreateDmResponse {
  readonly channel_id: number;
  readonly recipient: DmRecipient;
  readonly created: boolean;
}

/** TURN/STUN credentials from GET /api/voice/credentials. */
export interface IceServer {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
}

export interface VoiceCredentialsResponse {
  readonly ice_servers: readonly IceServer[];
  readonly expires_in: number;
}

// ── Admin: diagnostics / audit / logs ────────────────────────────────────────

export interface AdminStatsResponse {
  readonly user_count: number;
  readonly message_count: number;
  readonly channel_count: number;
  readonly server_count: number;
  readonly invite_count: number;
  readonly online_count: number;
  readonly db_size_bytes: number;
  readonly uptime_seconds: number;
  readonly version: string;
}

export interface ServiceHealthEntry {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly error: string | null;
}
export interface ServiceHealthResponse {
  readonly node: {
    readonly hostname: string;
    readonly online_here: number;
    readonly uptime_seconds: number;
    readonly redis_backplane: boolean;
  };
  readonly services: readonly ServiceHealthEntry[];
}

export interface AuditEntryResponse {
  readonly id: number;
  readonly actor_id: number;
  readonly actor_name: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: number;
  readonly detail: string;
  readonly created_at: string;
}

export interface AdminUserResponse {
  readonly id: number;
  readonly username: string;
  readonly role_id: number;
  readonly status: string;
  readonly banned: boolean;
  readonly created_at: string;
}

/** A single live-log line streamed from GET /api/v1/admin/logs/stream (SSE). */
export interface AdminLogLine {
  readonly ts: string;
  readonly level: string;
  readonly source: string;
  readonly msg: string;
}

// ── User search + friends ────────────────────────────────────────────────────

/** A public user card (search results, friend rows). */
export interface PublicUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly status: string;
}

/** GET /api/v1/friends response: accepted friends + pending in/out requests. */
export interface FriendsListResponse {
  readonly friends: readonly PublicUser[];
  readonly incoming: readonly PublicUser[];
  readonly outgoing: readonly PublicUser[];
}

// ── Friend + call WS payloads ────────────────────────────────────────────────

export interface FriendRequestPayload { readonly from: PublicUser }
export interface FriendAcceptedPayload { readonly user: PublicUser }
export interface FriendRemovedPayload { readonly user_id: number }

export interface CallCaller { readonly id: number; readonly username: string; readonly avatar: string | null }
export interface CallIncomingPayload { readonly caller: CallCaller; readonly channel_id: number }
export interface CallAcceptedPayload { readonly callee_id: number; readonly channel_id: number }
export interface CallDeclinedPayload { readonly callee_id: number; readonly reason: string }
export interface CallCancelledPayload { readonly caller_id: number }

/** A user the caller has blocked (GET /users/blocked). */
export interface BlockedUserDto {
  readonly user_id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly created_at: string;
}

/** `closed` is terminal: set by acting on the report, never by hand. */
export type ReportStatus = "open" | "resolved" | "dismissed" | "closed";

/** A reported message in the admin moderation inbox. `content` is the report-time snapshot. */
export interface MessageReportDto {
  readonly id: number;
  readonly reporter_id: number;
  readonly reporter_name: string;
  readonly message_id: number;
  readonly author_id: number;
  readonly author_name: string;
  readonly content: string;
  readonly reason: string;
  readonly status: ReportStatus;
  readonly created_at: string;
}

/** A voice channel and its guest link in the "Guest access" window (code null = no link yet). */
export interface GuestLinkRow {
  readonly channel_id: number;
  readonly channel_name: string;
  readonly code: string | null;
  readonly url: string | null;
}

/**
 * A SPACE is a tenant: its own database, users and servers. Not to be confused with a
 * server, which is what a user creates inside one.
 */
export interface AdminSpace {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly domain: string | null;
  readonly db_name: string;
  readonly active: boolean;
  readonly is_root: boolean;
  readonly user_count: number;
  readonly server_count: number;
}

/** Per-space SSO: each tenant brings its own OAuth app and mail-domain policy. */
export interface SpaceSso {
  readonly google_client_id: string;
  readonly google_client_secret: string;
  readonly yandex_client_id: string;
  readonly yandex_client_secret: string;
  readonly email_domains: string;
  readonly callback_base: string;
}

export interface AdminSpaceMember {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: string;
}

/** A server living inside a space (admin view). */
export interface SpaceServer {
  readonly id: number;
  readonly name: string;
  readonly owner_id: number;
  readonly icon: string | null;
}
