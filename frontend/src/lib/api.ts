// REST API Client — pure web (same-origin) fetch.

const platformFetch = window.fetch.bind(window);

/** Client-side upload ceiling — mirrors the server's 100 MB cap (nginx + Kestrel + endpoint). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

import { createLogger } from "./logger";
import { runtimeApiBase } from "./runtimeConfig";
import { getActiveServerId } from "@stores/servers.store";
import type {
  PublicUser,
  FriendsListResponse,
  AdminStatsResponse,
  ServiceHealthResponse,
  AuditEntryResponse,
  AdminUserResponse,
  AuthResponse,
  RegisterResponse,
  HealthResponse,
  MessagesResponse,
  SearchResponse,
  ApiError,
  ChannelType,
  ChannelResponse,
  EmojiResponse,
  SoundResponse,
  InviteResponse,
  RoleResponse,
  ServerDto,
  PublicServerDto,
  ServerVisibilityDto,
  BugReportDto,
  BugStatus,
  SessionResponse,
  UploadResponse,
  VoiceCredentialsResponse,
  MemberResponse,
  DmChannelsResponse,
  CreateDmResponse,
  BlockedUserDto,
  MessageReportDto,
  ReportStatus,
  GuestLinkRow,
  AdminSpace,
  AdminSpaceMember,
  SpaceServer,
  SpaceSso,
} from "./types";

/** Configuration for the API client. */
export interface ApiClientConfig {
  readonly host: string;
  readonly token?: string;
}

/** API client error with parsed error body. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

export type OnUnauthorized = () => void;

const log = createLogger("api");

/** Create the REST API client. */
export function createApiClient(
  initialConfig: ApiClientConfig,
  onUnauthorized?: OnUnauthorized,
) {
  let config = { ...initialConfig };

  function originFor(host: string): string {
    // Empty host (the default) → same-origin. A custom host — a FOREIGN instance picked on
    // the login screen — is assumed https regardless of the page's own protocol (a http
    // dev page can talk to a https instance; the reverse is blocked as mixed content
    // anyway). An explicit scheme in the host string is honored for LAN/dev targets.
    if (!host || host === window.location.host) return window.location.origin;
    if (host.includes("://")) return host.replace(/\/+$/, "");
    return `https://${host}`;
  }

  function baseUrl(): string {
    // Runtime override (subdomain ingress) wins; else same-origin /api/v1.
    return runtimeApiBase() ?? `${originFor(config.host)}/api/v1`;
  }

  function adminBaseUrl(): string {
    return `${baseUrl()}/admin`;
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      // Scope every request to the active server. Defaults to "1" when no
      // server is selected yet (see servers.store.getActiveServerId).
      "X-Server-Id": String(getActiveServerId()),
    };
    if (config.token) {
      h["Authorization"] = `Bearer ${config.token}`;
    }
    return h;
  }

  async function doFetch<T>(
    label: string,
    urlBase: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await doFetchResponse(label, urlBase, method, path, body, signal, extraHeaders);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /** The fetch/auth/error plumbing shared by doFetch and pagedGet (which needs the headers). */
  async function doFetchResponse(
    label: string,
    urlBase: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const url = `${urlBase}${path}`;
    const init: RequestInit = {
      method,
      headers: { ...headers(), ...extraHeaders },
      signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    log.debug(`${label} →`, { method, path });

    let res: Response;
    try {
      res = await platformFetch(url, init as RequestInit);
    } catch (fetchErr) {
      log.error(`${label} fetch failed`, { method, path, error: String(fetchErr) });
      if (fetchErr instanceof Error) {
        throw fetchErr;
      }
      throw new Error(typeof fetchErr === "string" ? fetchErr : String(fetchErr));
    }

    log.debug(`${label} ←`, { method, path, status: res.status });

    if (res.status === 401) {
      onUnauthorized?.();
      const err = await parseError(res);
      throw new ApiClientError(401, err.error, err.message);
    }

    if (!res.ok) {
      const err = await parseError(res);
      log.warn(`${label} error`, { method, path, status: res.status, code: err.error, message: err.message });
      throw new ApiClientError(res.status, err.error, err.message);
    }

    return res;
  }

  /** GET one page of a list endpoint: the body stays the plain array and the unpaged
   *  total rides the X-Total-Count header (see the server's paged admin endpoints). */
  async function pagedGet<T>(
    label: string,
    urlBase: string,
    path: string,
    limit: number,
    offset: number,
    signal?: AbortSignal,
  ): Promise<{ items: T[]; total: number }> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await doFetchResponse(label, urlBase, "GET", `${path}${sep}limit=${limit}&offset=${offset}`, undefined, signal);
    const items = (await res.json()) as T[];
    const total = Number(res.headers.get("X-Total-Count"));
    return { items, total: Number.isFinite(total) && total >= 0 ? total : items.length };
  }

  function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return doFetch<T>("API", baseUrl(), method, path, body, signal);
  }

  function adminRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return doFetch<T>("Admin API", adminBaseUrl(), method, path, body, signal);
  }

  async function parseError(res: Response): Promise<ApiError> {
    try {
      const body = await res.json();
      return {
        error: body.error ?? "UNKNOWN",
        message: body.message ?? res.statusText,
      };
    } catch {
      return {
        error: "UNKNOWN",
        message: res.statusText,
      };
    }
  }

  return {
    /** Update the client config (e.g., after login). */
    setConfig(newConfig: Partial<ApiClientConfig>): void {
      config = { ...config, ...newConfig };
    },

    /** Get current config (for debugging). Token is redacted. */
    getConfig(): Readonly<ApiClientConfig> {
      return { ...config, token: config.token ? "[redacted]" : undefined };
    },

    // ── First-run setup ───────────────────────────────────

    getSetupStatus(signal?: AbortSignal): Promise<{ needs_setup: boolean; invite_required?: boolean }> {
      return request<{ needs_setup: boolean; invite_required?: boolean }>("GET", "/setup/status", undefined, signal);
    },

    setup(
      email: string,
      username: string,
      password: string,
      signal?: AbortSignal,
    ): Promise<{ token: string; user_id: number; username: string; invite_code: string }> {
      return request("POST", "/setup", { email, username, password }, signal);
    },

    // ── Auth (login is by email) ──────────────────────────

    login(
      email: string,
      password: string,
      signal?: AbortSignal,
    ): Promise<AuthResponse> {
      return request<AuthResponse>(
        "POST",
        "/auth/login",
        { email, password },
        signal,
      );
    },

    register(
      email: string,
      username: string,
      password: string,
      inviteCode: string,
      signal?: AbortSignal,
    ): Promise<RegisterResponse> {
      return request<RegisterResponse>(
        "POST",
        "/auth/register",
        { email, username, password, invite_code: inviteCode },
        signal,
      );
    },

    /** Which SSO providers this deployment holds keys for (["google","yandex"], or empty). */
    ssoProviders(signal?: AbortSignal): Promise<{ providers: string[] }> {
      return request<{ providers: string[] }>("GET", "/auth/oauth/providers", undefined, signal);
    },

    logout(signal?: AbortSignal): Promise<void> {
      return request<void>("POST", "/auth/logout", undefined, signal);
    },

    async verifyTotp(
      code: string,
      partialToken: string,
      signal?: AbortSignal,
    ): Promise<AuthResponse> {
      // Don't mutate shared config — make direct fetch with the partial token
      const url = `${baseUrl()}/auth/verify-totp`;
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${partialToken}`,
          "X-Server-Id": String(getActiveServerId()),
        },
        body: JSON.stringify({ code }),
        signal,
      };

      let res: Response;
      try {
        res = await platformFetch(url, init as RequestInit);
      } catch (fetchErr) {
        log.error("API fetch failed", { method: "POST", path: "/auth/verify-totp", error: String(fetchErr) });
        if (fetchErr instanceof Error) {
          throw fetchErr;
        }
        throw new Error(typeof fetchErr === "string" ? fetchErr : String(fetchErr));
      }

      if (res.status === 401) {
        onUnauthorized?.();
        const err = await parseError(res);
        throw new ApiClientError(401, err.error, err.message);
      }

      if (!res.ok) {
        const err = await parseError(res);
        throw new ApiClientError(res.status, err.error, err.message);
      }

      return res.json() as Promise<AuthResponse>;
    },

    /** Complete an email-verified registration: pending token in Authorization, { code } in body. */
    verifyRegistration(code: string, partialToken: string, signal?: AbortSignal): Promise<AuthResponse> {
      return doFetch<AuthResponse>("API", baseUrl(), "POST", "/auth/register/verify", { code }, signal,
        { Authorization: `Bearer ${partialToken}` });
    },

    /** Request a password-reset code by email. Always resolves (the server answers 204 whether or
     *  not the address has an account) — never surface existence to the caller. */
    forgotPassword(email: string, signal?: AbortSignal): Promise<void> {
      return doFetch<void>("API", baseUrl(), "POST", "/auth/password/forgot", { email }, signal);
    },

    /** Complete a reset: emailed code + new password → sets it and logs in (returns a session). */
    resetPassword(email: string, code: string, newPassword: string, signal?: AbortSignal): Promise<AuthResponse> {
      return doFetch<AuthResponse>("API", baseUrl(), "POST", "/auth/password/reset",
        { email, code, new_password: newPassword }, signal);
    },

    async verifyEmailOtp(
      code: string,
      partialToken: string,
      signal?: AbortSignal,
    ): Promise<AuthResponse> {
      const url = `${baseUrl()}/auth/verify-email-otp`;
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${partialToken}`,
          "X-Server-Id": String(getActiveServerId()),
        },
        body: JSON.stringify({ code }),
        signal,
      };

      let res: Response;
      try {
        res = await platformFetch(url, init as RequestInit);
      } catch (fetchErr) {
        log.error("API fetch failed", { method: "POST", path: "/auth/verify-email-otp", error: String(fetchErr) });
        if (fetchErr instanceof Error) throw fetchErr;
        throw new Error(typeof fetchErr === "string" ? fetchErr : String(fetchErr));
      }

      if (res.status === 401) {
        onUnauthorized?.();
        const err = await parseError(res);
        throw new ApiClientError(401, err.error, err.message);
      }
      if (!res.ok) {
        const err = await parseError(res);
        throw new ApiClientError(res.status, err.error, err.message);
      }
      return res.json() as Promise<AuthResponse>;
    },

    deleteAccount(password: string, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "DELETE",
        "/auth/account",
        { password },
        signal,
      );
    },

    // ── Users ─────────────────────────────────────────────

    getMe(signal?: AbortSignal): Promise<MemberResponse> {
      return request<MemberResponse>("GET", "/users/me", undefined, signal);
    },

    updateProfile(
      data: { username?: string; avatar?: string },
      signal?: AbortSignal,
    ): Promise<MemberResponse> {
      return request<MemberResponse>("PATCH", "/users/me", data, signal);
    },

    /** Show message text in push notifications, or only who sent it. Account-wide. */
    setPushPreview(on: boolean, signal?: AbortSignal): Promise<MemberResponse> {
      return request<MemberResponse>("PATCH", "/users/me", { push_preview: on }, signal);
    },

    changePassword(
      currentPassword: string,
      newPassword: string,
      signal?: AbortSignal,
    ): Promise<void> {
      return request<void>(
        "PUT",
        "/users/me/password",
        { current_password: currentPassword, new_password: newPassword },
        signal,
      );
    },

    enableTotp(password: string, signal?: AbortSignal): Promise<{ qr_uri: string; backup_codes: string[] }> {
      return request("POST", "/users/me/totp/enable", { password }, signal);
    },

    confirmTotp(password: string, code: string, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", "/users/me/totp/confirm", { password, code }, signal);
    },

    disableTotp(password: string, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", "/users/me/totp", { password }, signal);
    },

    getSessions(signal?: AbortSignal): Promise<SessionResponse[]> {
      return request<SessionResponse[]>(
        "GET",
        "/users/me/sessions",
        undefined,
        signal,
      );
    },

    revokeSession(sessionId: number, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "DELETE",
        `/users/me/sessions/${sessionId}`,
        undefined,
        signal,
      );
    },

    /** "Sign out everywhere else": revokes all sessions except the calling one. */
    revokeAllSessions(signal?: AbortSignal): Promise<{ revoked: number }> {
      return request<{ revoked: number }>(
        "DELETE",
        "/users/me/sessions",
        undefined,
        signal,
      );
    },

    // ── Servers ───────────────────────────────────────────

    /** List the servers the current user is a member of. */
    getServers(signal?: AbortSignal): Promise<ServerDto[]> {
      return request<ServerDto[]>("GET", "/servers", undefined, signal);
    },

    /** Create a server; the creator becomes its owner/admin. */
    createServer(name: string, signal?: AbortSignal): Promise<ServerDto> {
      return request<ServerDto>("POST", "/servers", { name }, signal);
    },

    /** Join a server via an invite code. */
    joinServer(code: string, signal?: AbortSignal): Promise<ServerDto> {
      return request<ServerDto>("POST", "/servers/join", { code }, signal);
    },

    // ── Public server directory ("Explore") ───────────────
    /** Public servers the user can discover + join without an invite. */
    discoverServers(signal?: AbortSignal): Promise<PublicServerDto[]> {
      return request<PublicServerDto[]>("GET", "/servers/discover", undefined, signal);
    },
    /** Join a public server directly (no invite). */
    joinPublicServer(id: number, signal?: AbortSignal): Promise<ServerDto> {
      return request<ServerDto>("POST", `/servers/${id}/join-public`, undefined, signal);
    },
    /** Owner: read this server's discovery settings. */
    getServerVisibility(id: number, signal?: AbortSignal): Promise<ServerVisibilityDto> {
      return request<ServerVisibilityDto>("GET", `/servers/${id}/visibility`, undefined, signal);
    },
    /** Owner: set public flag + description. */
    setServerVisibility(id: number, isPublic: boolean, description: string, signal?: AbortSignal): Promise<void> {
      return request<void>("PATCH", `/servers/${id}/visibility`, { is_public: isPublic, description }, signal);
    },

    // ── Bug reports ("Send To Developer") ─────────────────
    /** File a bug report (any user). Attachments are /api/v1/files/{id} URLs from uploadFile. */
    createBug(description: string, title: string, attachments: string[], signal?: AbortSignal): Promise<BugReportDto> {
      return request<BugReportDto>("POST", "/bugs", { description, title, attachments }, signal);
    },
    /** The caller's own bug reports, newest first. */
    getMyBugs(signal?: AbortSignal): Promise<BugReportDto[]> {
      return request<BugReportDto[]>("GET", "/bugs/mine", undefined, signal);
    },
    /** Owner: every bug report across the instance. */
    adminListBugs(signal?: AbortSignal): Promise<BugReportDto[]> {
      return adminRequest<BugReportDto[]>("GET", "/bugs", undefined, signal);
    },
    /** Owner: move a report to a new status (new | in_progress | fixed). */
    adminSetBugStatus(id: number, status: BugStatus, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("PATCH", `/bugs/${id}/status`, { status }, signal);
    },

    // ── User search + friends ─────────────────────────────

    /** Search users by username or email (partial, case-insensitive). */
    searchUsers(q: string, signal?: AbortSignal): Promise<PublicUser[]> {
      return request<PublicUser[]>("GET", `/users/search?q=${encodeURIComponent(q)}`, undefined, signal);
    },

    /** List accepted friends + pending incoming/outgoing requests. */
    getFriends(signal?: AbortSignal): Promise<FriendsListResponse> {
      return request<FriendsListResponse>("GET", "/friends", undefined, signal);
    },

    /** Send a friend request (or auto-accept a reverse pending one). */
    sendFriendRequest(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", "/friends", { user_id: userId }, signal);
    },

    /** Accept an incoming friend request. */
    acceptFriend(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", `/friends/${userId}/accept`, undefined, signal);
    },

    /** Remove a friend / decline or cancel a pending request. */
    removeFriend(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/friends/${userId}`, undefined, signal);
    },

    /** Rename a server and/or set its picture. Owner / server-admin.
     *  icon: undefined leaves it alone, "" removes it, otherwise a /api/v1/files/{id} URL. */
    renameServer(id: number, name: string, icon?: string, signal?: AbortSignal): Promise<void> {
      return request<void>("PATCH", `/servers/${id}`, icon === undefined ? { name } : { name, icon }, signal);
    },

    /** Soft-delete a server (owner only): kicks all members, then hides it. */
    deleteServer(id: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/servers/${id}`, undefined, signal);
    },

    /** Assign (or clear with null) a member's PER-SERVER role. Owner of that server or global admin. */
    assignServerRole(serverId: number, userId: number, roleId: number | null, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", `/servers/${serverId}/members/${userId}/role`, { role_id: roleId }, signal);
    },

    /** Remove a member from a server (per-server kick — not a global ban). Owner / server-admin. */
    kickServerMember(serverId: number, userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/servers/${serverId}/members/${userId}`, undefined, signal);
    },

    // ── Channels ──────────────────────────────────────────

    getMessages(
      channelId: number,
      options?: { before?: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<MessagesResponse> {
      const params = new URLSearchParams();
      if (options?.before !== undefined) params.set("before", String(options.before));
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      return request<MessagesResponse>(
        "GET",
        `/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
        undefined,
        signal,
      );
    },

    getPins(channelId: number, signal?: AbortSignal): Promise<MessagesResponse> {
      return request<MessagesResponse>(
        "GET",
        `/channels/${channelId}/pins`,
        undefined,
        signal,
      );
    },

    pinMessage(
      channelId: number,
      messageId: number,
      signal?: AbortSignal,
    ): Promise<void> {
      return request<void>(
        "POST",
        `/channels/${channelId}/pins/${messageId}`,
        undefined,
        signal,
      );
    },

    unpinMessage(
      channelId: number,
      messageId: number,
      signal?: AbortSignal,
    ): Promise<void> {
      return request<void>(
        "DELETE",
        `/channels/${channelId}/pins/${messageId}`,
        undefined,
        signal,
      );
    },

    // ── Search ────────────────────────────────────────────

    search(
      query: string,
      options?: { channelId?: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<SearchResponse> {
      const params = new URLSearchParams({ q: query });
      if (options?.channelId !== undefined) params.set("channel_id", String(options.channelId));
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      return request<SearchResponse>(
        "GET",
        `/search?${params.toString()}`,
        undefined,
        signal,
      );
    },

    // ── File Uploads ──────────────────────────────────────

    async uploadFile(
      file: File,
      signal?: AbortSignal,
    ): Promise<UploadResponse> {
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new ApiClientError(413, "FILE_TOO_LARGE", "File exceeds the 10 MB limit");
      }
      const formData = new FormData();
      formData.append("file", file);

      const url = `${baseUrl()}/uploads`;
      const h: Record<string, string> = {
        "X-Server-Id": String(getActiveServerId()),
      };
      if (config.token) {
        h["Authorization"] = `Bearer ${config.token}`;
      }
      // Don't set Content-Type — browser sets multipart boundary

      const res = await platformFetch(url, {
        method: "POST",
        headers: h,
        body: formData,
        signal,
      } as RequestInit);

      if (!res.ok) {
        const err = await parseError(res);
        throw new ApiClientError(res.status, err.error, err.message);
      }

      return res.json() as Promise<UploadResponse>;
    },

    /** Upload a recorded voice clip. The server normalizes it to m4a and returns duration +
     *  waveform. Any recorder container (webm/ogg/mp4) is accepted. */
    async uploadVoice(blob: Blob, signal?: AbortSignal): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", blob, "voice.webm");
      const h: Record<string, string> = { "X-Server-Id": String(getActiveServerId()) };
      if (config.token) h["Authorization"] = `Bearer ${config.token}`;
      const res = await platformFetch(`${baseUrl()}/uploads/voice`, {
        method: "POST", headers: h, body: formData, signal,
      } as RequestInit);
      if (!res.ok) {
        const err = await parseError(res);
        throw new ApiClientError(res.status, err.error, err.message);
      }
      return res.json() as Promise<UploadResponse>;
    },

    /** Upload a file reporting 0-100 progress via XHR (fetch can't report upload progress). */
    /**
     * @param asFile Send it untouched. Without this a picture is stored at screen size —
     *   the copy everyone actually looks at — and the upload itself is not kept, which is the
     *   difference between a bucket that grows with the conversation and one that grows with
     *   the camera. Set it when the sender chose "file" rather than "photo".
     */
    uploadFileWithProgress(
      file: File,
      onProgress: (pct: number) => void,
      asFile = false,
      signal?: AbortSignal,
    ): Promise<UploadResponse> {
      return new Promise<UploadResponse>((resolve, reject) => {
        if (file.size > MAX_UPLOAD_BYTES) {
          reject(new ApiClientError(413, "FILE_TOO_LARGE", "File exceeds the 10 MB limit"));
          return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${baseUrl()}/uploads`);
        xhr.setRequestHeader("X-Server-Id", String(getActiveServerId()));
        if (config.token) xhr.setRequestHeader("Authorization", `Bearer ${config.token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText) as UploadResponse); }
            catch { reject(new ApiClientError(xhr.status, "PARSE_ERROR", "Invalid upload response")); }
          } else {
            reject(new ApiClientError(xhr.status, "UPLOAD_FAILED", xhr.responseText || "Upload failed"));
          }
        };
        xhr.onerror = () => reject(new ApiClientError(0, "NETWORK_ERROR", "Network error during upload"));
        if (signal) signal.addEventListener("abort", () => xhr.abort());
        const fd = new FormData();
        fd.append("file", file);
        if (asFile) fd.append("as_file", "1");
        xhr.send(fd);
      });
    },

    // ── Moderation: blocks & reports ──────────────────────

    /** Block a user: cuts DMs, calls and friend requests BOTH ways (server-enforced). */
    blockUser(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("PUT", `/users/${userId}/block`, undefined, signal);
    },

    unblockUser(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/users/${userId}/block`, undefined, signal);
    },

    listBlocked(signal?: AbortSignal): Promise<BlockedUserDto[]> {
      return request<BlockedUserDto[]>("GET", "/users/blocked", undefined, signal);
    },

    /** Report a message into the admin moderation inbox (content is snapshotted server-side). */
    reportMessage(messageId: number, reason: string, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", `/messages/${messageId}/report`, { reason }, signal);
    },

    /** Admin: paged moderation inbox. */
    adminListReportsPaged(limit: number, offset: number, signal?: AbortSignal): Promise<{ items: MessageReportDto[]; total: number }> {
      return pagedGet<MessageReportDto>("API", baseUrl(), "/admin/reports", limit, offset, signal);
    },

    adminSetReportStatus(id: number, status: ReportStatus, signal?: AbortSignal): Promise<void> {
      return request<void>("PATCH", `/admin/reports/${id}/status`, { status }, signal);
    },

    /** Every voice channel of the active server with its guest link (null when it has none). */
    getGuestLinks(signal?: AbortSignal): Promise<GuestLinkRow[]> {
      return request<GuestLinkRow[]>("GET", "/servers/guest-links", undefined, signal);
    },

    /** Mint (or fetch) the shareable no-login guest link for a voice channel. */
    createGuestLink(channelId: number, signal?: AbortSignal): Promise<{ code: string; url: string }> {
      return request<{ code: string; url: string }>("POST", `/channels/${channelId}/guest-link`, undefined, signal);
    },

    /** Kill the channel's link — the code stops working immediately; a new one can be minted. */
    revokeGuestLink(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/channels/${channelId}/guest-link`, undefined, signal);
    },

    // ── Invites ───────────────────────────────────────────

    getInvites(signal?: AbortSignal): Promise<InviteResponse[]> {
      return request<InviteResponse[]>("GET", "/invites", undefined, signal);
    },

    getInvitesPaged(limit: number, offset: number, signal?: AbortSignal): Promise<{ items: InviteResponse[]; total: number }> {
      return pagedGet<InviteResponse>("API", baseUrl(), "/invites", limit, offset, signal);
    },

    createInvite(
      data: { max_uses?: number; expires_in_hours?: number },
      signal?: AbortSignal,
    ): Promise<InviteResponse> {
      return request<InviteResponse>("POST", "/invites", data, signal);
    },

    revokeInvite(code: string, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/invites/${code}`, undefined, signal);
    },

    // ── Emoji ─────────────────────────────────────────────

    getEmoji(signal?: AbortSignal): Promise<EmojiResponse[]> {
      return request<EmojiResponse[]>("GET", "/emoji", undefined, signal);
    },

    deleteEmoji(emojiId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/emoji/${emojiId}`, undefined, signal);
    },

    // ── Sounds ────────────────────────────────────────────

    getSounds(signal?: AbortSignal): Promise<SoundResponse[]> {
      return request<SoundResponse[]>("GET", "/sounds", undefined, signal);
    },

    deleteSound(soundId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/sounds/${soundId}`, undefined, signal);
    },

    // ── Direct Messages ─────────────────────────────────────

    /** List user's open DM channels. */
    getDmChannels(signal?: AbortSignal): Promise<DmChannelsResponse> {
      return request<DmChannelsResponse>("GET", "/dms", undefined, signal);
    },

    /** Create or get a DM channel with a user. */
    createDm(
      recipientId: number,
      signal?: AbortSignal,
    ): Promise<CreateDmResponse> {
      return request<CreateDmResponse>(
        "POST",
        "/dms",
        { recipient_id: recipientId },
        signal,
      );
    },

    /** Close a DM (hide from sidebar). */
    closeDm(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/dms/${channelId}`, undefined, signal);
    },

    // ── Spaces: the tenants of this instance (root admin only) ──────────────
    adminListSpaces(signal?: AbortSignal): Promise<readonly AdminSpace[]> {
      return adminRequest("GET", "/spaces/", undefined, signal);
    },
    adminCreateSpace(body: {
      slug: string; name: string; domain?: string;
      owner_email?: string; owner_username?: string; owner_password?: string;
    }, signal?: AbortSignal): Promise<AdminSpace> {
      return adminRequest("POST", "/spaces/", body, signal);
    },
    adminUpdateSpace(id: number, body: { name?: string; domain?: string; active?: boolean }, signal?: AbortSignal): Promise<AdminSpace> {
      return adminRequest("PUT", `/spaces/${id}`, body, signal);
    },
    adminDeleteSpace(id: number, signal?: AbortSignal): Promise<void> {
      return adminRequest("DELETE", `/spaces/${id}`, undefined, signal);
    },
    adminSpaceUsers(id: number, signal?: AbortSignal): Promise<readonly AdminUserResponse[]> {
      return adminRequest("GET", `/spaces/${id}/users`, undefined, signal);
    },
    adminSpaceServers(id: number, signal?: AbortSignal): Promise<readonly SpaceServer[]> {
      return adminRequest("GET", `/spaces/${id}/servers`, undefined, signal);
    },
    adminSpaceBranding(id: number, signal?: AbortSignal): Promise<{ name: string; icon: string }> {
      return adminRequest("GET", `/spaces/${id}/branding`, undefined, signal);
    },
    adminSetSpaceBranding(id: number, body: { name?: string; icon?: string }, signal?: AbortSignal): Promise<void> {
      return adminRequest("PUT", `/spaces/${id}/branding`, body, signal);
    },
    adminSpaceSso(id: number, signal?: AbortSignal): Promise<SpaceSso> {
      return adminRequest("GET", `/spaces/${id}/sso`, undefined, signal);
    },
    adminSetSpaceSso(id: number, body: {
      google_client_id?: string; google_client_secret?: string;
      yandex_client_id?: string; yandex_client_secret?: string; email_domains?: string;
    }, signal?: AbortSignal): Promise<void> {
      return adminRequest("PUT", `/spaces/${id}/sso`, body, signal);
    },
    adminCreateSpaceOwner(id: number, body: { email: string; username: string; password: string }, signal?: AbortSignal): Promise<{ id: number }> {
      return adminRequest("POST", `/spaces/${id}/owner`, body, signal);
    },

    /** Which space serves the host this page was loaded from — the login screen's branding. */
    getSpaceByHost(signal?: AbortSignal): Promise<{ space_id: number; slug: string; name: string; icon: string | null; is_root: boolean }> {
      return request("GET", "/space-by-host", undefined, signal);
    },

    /** Channels of ANY server the user belongs to (forward dialog) — overrides the
     *  tenant header; the middleware enforces membership. */
    getServerChannels(serverId: number, signal?: AbortSignal): Promise<readonly { id: number; name: string; type: string }[]> {
      return doFetch("API", baseUrl(), "GET", "/channels", undefined, signal, { "X-Server-Id": String(serverId) });
    },

    /** Mute notifications for a chat (per-user; works for DMs and server channels). */
    muteChannel(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("PUT", `/channels/${channelId}/mute`, undefined, signal);
    },

    unmuteChannel(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/channels/${channelId}/mute`, undefined, signal);
    },

    // ── Voice ─────────────────────────────────────────────

    getVoiceCredentials(
      signal?: AbortSignal,
    ): Promise<VoiceCredentialsResponse> {
      return request<VoiceCredentialsResponse>(
        "GET",
        "/voice/credentials",
        undefined,
        signal,
      );
    },

    // ── Health ────────────────────────────────────────────

    async getHealth(
      host?: string,
      timeoutMs = 3000,
    ): Promise<HealthResponse> {
      const targetHost = host ?? config.host;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await platformFetch(`${originFor(targetHost)}/api/v1/health`, {
          signal: controller.signal,
        } as RequestInit);
        if (!res.ok) {
          throw new ApiClientError(res.status, "HEALTH_CHECK_FAILED", "Health check failed");
        }
        return res.json() as Promise<HealthResponse>;
      } finally {
        clearTimeout(timer);
      }
    },

    // ── Admin: Channels ──────────────────────────────────────

    adminCreateChannel(
      data: {
        name: string;
        type: ChannelType;
        category: string;
        topic?: string;
        position?: number;
      },
      signal?: AbortSignal,
      serverId?: number,
    ): Promise<ChannelResponse> {
      // serverId overrides the active-server header so the instance admin can create a
      // channel inside ANY tenant from the Servers panel.
      return doFetch<ChannelResponse>("Admin API", adminBaseUrl(), "POST", "/channels", data, signal,
        serverId !== undefined ? { "X-Server-Id": String(serverId) } : undefined);
    },

    adminUpdateChannel(
      id: number,
      data: {
        name?: string;
        topic?: string;
        slow_mode?: number;
        position?: number;
        archived?: boolean;
      },
      signal?: AbortSignal,
    ): Promise<ChannelResponse> {
      return adminRequest<ChannelResponse>("PATCH", `/channels/${id}`, data, signal);
    },

    adminDeleteChannel(
      id: number,
      signal?: AbortSignal,
    ): Promise<void> {
      return adminRequest<void>("DELETE", `/channels/${id}`, undefined, signal);
    },

    // ── Admin: Members ──────────────────────────────────────

    adminKickMember(
      userId: number,
      signal?: AbortSignal,
    ): Promise<void> {
      return adminRequest<void>("DELETE", `/users/${userId}/sessions`, undefined, signal);
    },

    adminBanMember(
      userId: number,
      reason?: string,
      signal?: AbortSignal,
    ): Promise<void> {
      return adminRequest<void>("PATCH", `/users/${userId}`, {
        banned: true,
        ban_reason: reason ?? "",
      }, signal);
    },

    adminChangeRole(
      userId: number,
      roleId: number,
      signal?: AbortSignal,
    ): Promise<void> {
      return adminRequest<void>("PATCH", `/users/${userId}`, {
        role_id: roleId,
      }, signal);
    },

    adminUnbanMember(userId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("POST", `/users/${userId}/unban`, undefined, signal);
    },

    /** Hard-delete a user account (instance admin) — permanent, not soft. */
    adminHardDeleteUser(userId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("DELETE", `/users/${userId}`, undefined, signal);
    },

    /** All permission names the system knows about (for the grant picker). */
    adminListPermissions(signal?: AbortSignal): Promise<string[]> {
      return adminRequest<string[]>("GET", "/permissions", undefined, signal);
    },
    /** Permissions granted DIRECTLY to a user (on top of their role). */
    adminGetUserPermissions(userId: number, signal?: AbortSignal): Promise<string[]> {
      return adminRequest<string[]>("GET", `/users/${userId}/permissions`, undefined, signal);
    },
    adminGrantPermission(userId: number, permission: string, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("POST", `/users/${userId}/permissions`, { permission }, signal);
    },
    adminRevokePermission(userId: number, permission: string, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("DELETE", `/users/${userId}/permissions/${permission}`, undefined, signal);
    },

    /** All servers (instance admin) + force-delete any server / any channel. */
    adminListAllServers(signal?: AbortSignal): Promise<{ id: number; name: string; owner_id: number; icon: string | null }[]> {
      return adminRequest("GET", "/servers", undefined, signal);
    },
    adminListAllServersPaged(limit: number, offset: number, signal?: AbortSignal): Promise<{ items: { id: number; name: string; owner_id: number; icon: string | null }[]; total: number }> {
      return pagedGet("Admin API", adminBaseUrl(), "/servers", limit, offset, signal);
    },
    adminDeleteServer(serverId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("DELETE", `/servers/${serverId}`, undefined, signal);
    },
    adminListServerChannels(serverId: number, signal?: AbortSignal): Promise<{ id: number; name: string; type: string; category: string | null; server_id: number | null }[]> {
      return adminRequest("GET", `/servers/${serverId}/channels`, undefined, signal);
    },
    adminForceDeleteChannel(channelId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("DELETE", `/channels/${channelId}/force`, undefined, signal);
    },

    // ── Admin: Diagnostics / Users / Audit / Logs ────────────

    /** List all users (admin view: role, status, ban, created). */
    adminListUsers(signal?: AbortSignal): Promise<AdminUserResponse[]> {
      return adminRequest<AdminUserResponse[]>("GET", "/users", undefined, signal);
    },

    /** One page of users, searched server-side (the list is paginated, so a client-side
     *  filter would only ever see the current page). */
    adminListUsersPaged(limit: number, offset: number, search?: string, signal?: AbortSignal): Promise<{ items: AdminUserResponse[]; total: number }> {
      const q = search && search.trim().length > 0 ? `?q=${encodeURIComponent(search.trim())}` : "";
      return pagedGet<AdminUserResponse>("Admin API", adminBaseUrl(), `/users${q}`, limit, offset, signal);
    },

    /** Server diagnostics: counts, online, DB size, uptime, version. */
    getServerStats(signal?: AbortSignal): Promise<AdminStatsResponse> {
      return adminRequest<AdminStatsResponse>("GET", "/stats", undefined, signal);
    },

    /** Liveness of each backing service + which replica answered (owner health view). */
    getServiceHealth(signal?: AbortSignal): Promise<ServiceHealthResponse> {
      return adminRequest<ServiceHealthResponse>("GET", "/health/services", undefined, signal);
    },

    /** Paginated audit log (newest first). */
    getAuditLog(limit = 50, offset = 0, signal?: AbortSignal): Promise<AuditEntryResponse[]> {
      return adminRequest<AuditEntryResponse[]>("GET", `/audit-log?limit=${limit}&offset=${offset}`, undefined, signal);
    },

    /** Exchange the session for a single-use ticket to open the live-log SSE stream. */
    getLogTicket(signal?: AbortSignal): Promise<{ ticket: string }> {
      return adminRequest<{ ticket: string }>("POST", "/logs/ticket", undefined, signal);
    },

    /** Absolute URL for the live-log EventSource (carries the single-use ticket). */
    adminLogStreamUrl(ticket: string): string {
      return `${adminBaseUrl()}/logs/stream?ticket=${encodeURIComponent(ticket)}`;
    },

    // ── Admin: Server settings ───────────────────────────────

    getAdminSettings(signal?: AbortSignal): Promise<Record<string, string>> {
      return adminRequest<Record<string, string>>("GET", "/settings", undefined, signal);
    },

    updateAdminSettings(
      settings: Record<string, string>,
      signal?: AbortSignal,
    ): Promise<Record<string, string>> {
      return adminRequest<Record<string, string>>("PATCH", "/settings", settings, signal);
    },

    // ── Roles ─────────────────────────────────────────────

    getRoles(signal?: AbortSignal): Promise<RoleResponse[]> {
      return request<RoleResponse[]>("GET", "/roles", undefined, signal);
    },

    createRole(
      data: { name: string; color?: string; permissions: number; position: number },
      signal?: AbortSignal,
    ): Promise<RoleResponse> {
      return request<RoleResponse>("POST", "/roles", data, signal);
    },

    updateRole(
      id: number,
      data: { name?: string; color?: string; permissions?: number; position?: number },
      signal?: AbortSignal,
    ): Promise<RoleResponse> {
      return request<RoleResponse>("PATCH", `/roles/${id}`, data, signal);
    },

    deleteRole(id: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/roles/${id}`, undefined, signal);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
