# REST API

Base path `/api/v1`. Authentication is a bearer JWT from `/auth/login` or `/auth/register`;
the WebSocket authenticates separately and in-band (see [protocol.md](protocol.md)).

**The generated spec is authoritative.** The server emits OpenAPI at `/openapi` and serves a
browsable reference at `/scalar` — both built from the code, so neither can drift. This page
is the map: the conventions, the things the spec cannot tell you, and an inventory of what
exists so you can read it without a running server.

## Conventions

- **JSON is snake_case** both ways. The server's serializer is configured with
  `SnakeCaseLower`, so a C# `DisplayName` is `display_name` on the wire — including in request
  bodies, which is the usual reason a field silently arrives null.
- **Errors** are `{"error": "CODE", "message": "..."}` with a matching HTTP status.
  `INVALID_INPUT` is 400, `RATE_LIMITED` is 429, and a failed outbound dependency (mail, for
  instance) is **503** rather than 500 — the request was valid and something downstream was
  not, and the two mean different things to whoever reads the response.
- **Tenancy** is resolved per request from the host and the token; the same path serves
  different spaces and you do not pass a space id.
- **Rate limits** are per client IP and global, per endpoint. The client address comes from the
  socket unless the peer is a configured trusted proxy — see [security.md](security.md).
- Ids are 64-bit integers. Timestamps are ISO-8601 UTC.

## Uploads

`POST /api/v1/uploads` takes multipart and streams to object storage without buffering the
file. The cap is `Upload:MaxSizeMb` (100 by default) and the edge enforces the same limit, so
an oversized body is rejected before it reaches the API. Attachments are then referenced by id
when the message is sent over the socket.

Downloads support Range, which is not a detail: iOS refuses to play progressive audio from a
response with no `Content-Length`, so a voice message served sequentially downloads fine and
never plays.

## Inventory

Grouped by the file that declares them. Paths in **Admin** are relative to `/api/v1/admin`;
everything else is absolute.

### Admin

| `GET` | `/audit-log` |
| `POST` | `/channels` |
| `DELETE` | `/channels/{id}` |
| `PATCH` | `/channels/{id}` |
| `DELETE` | `/channels/{id}/force` |
| `GET` | `/health/services` |
| `POST` | `/logs/ticket` |
| `GET` | `/permissions` |
| `GET` | `/servers` |
| `DELETE` | `/servers/{id}` |
| `GET` | `/servers/{id}/channels` |
| `GET` | `/settings` |
| `PATCH` | `/settings` |
| `GET` | `/stats` |
| `GET` | `/users` |
| `DELETE` | `/users/{id}` |
| `PATCH` | `/users/{id}` |
| `POST` | `/users/{id}/ban` |
| `GET` | `/users/{id}/permissions` |
| `POST` | `/users/{id}/permissions` |
| `DELETE` | `/users/{id}/permissions/{permission}` |
| `DELETE` | `/users/{id}/sessions` |
| `POST` | `/users/{id}/unban` |

### Auth

| `DELETE` | `/account` |
| `DELETE` | `/api/v1/users/me/totp` |
| `POST` | `/api/v1/users/me/totp/confirm` |
| `POST` | `/api/v1/users/me/totp/enable` |
| `POST` | `/login` |
| `POST` | `/logout` |
| `GET` | `/me` |
| `POST` | `/password/forgot` |
| `POST` | `/password/reset` |
| `POST` | `/register` |
| `POST` | `/register/verify` |
| `POST` | `/verify-email-otp` |
| `POST` | `/verify-totp` |

### Bug

| `GET` | `/api/v1/admin/bugs` |
| `PATCH` | `/api/v1/admin/bugs/{id}/status` |
| `POST` | `/api/v1/bugs` |
| `GET` | `/api/v1/bugs/mine` |

### Channel

| `GET` | `/api/v1/channels` |
| `GET` | `/api/v1/channels/{id}/messages` |
| `DELETE` | `/api/v1/channels/{id}/mute` |
| `PUT` | `/api/v1/channels/{id}/mute` |
| `GET` | `/api/v1/channels/{id}/pins` |
| `DELETE` | `/api/v1/channels/{id}/pins/{messageId}` |
| `POST` | `/api/v1/channels/{id}/pins/{messageId}` |

### Device

| `POST` | `/api/v1/devices` |
| `DELETE` | `/api/v1/devices/{token}` |

### Dm

| `GET` | `/api/v1/dms` |
| `POST` | `/api/v1/dms` |
| `DELETE` | `/api/v1/dms/{channelId}` |

### Friend

| `GET` | `/api/v1/friends` |
| `POST` | `/api/v1/friends` |
| `DELETE` | `/api/v1/friends/{userId}` |
| `POST` | `/api/v1/friends/{userId}/accept` |

### Guest

| `DELETE` | `/api/v1/channels/{id}/guest-link` |
| `POST` | `/api/v1/channels/{id}/guest-link` |
| `GET` | `/api/v1/guest/{code}` |
| `POST` | `/api/v1/guest/{code}/join` |
| `GET` | `/api/v1/servers/guest-links` |

### Invite

| `GET` | `/api/v1/invites` |
| `POST` | `/api/v1/invites` |
| `DELETE` | `/api/v1/invites/{code}` |

### LiveKit

| `GET` | `/api/v1/livekit/health` |
| `POST` | `/api/v1/livekit/webhook` |

### Media

| `GET` | `/api/v1/emoji` |
| `DELETE` | `/api/v1/emoji/{id}` |
| `GET` | `/api/v1/sounds` |
| `DELETE` | `/api/v1/sounds/{id}` |

### Moderation

| `GET` | `/api/v1/admin/reports` |
| `PATCH` | `/api/v1/admin/reports/{id}/status` |
| `POST` | `/api/v1/messages/{id}/report` |
| `GET` | `/api/v1/users/blocked` |
| `DELETE` | `/api/v1/users/{id}/block` |
| `PUT` | `/api/v1/users/{id}/block` |

### OAuth

| `GET` | `/providers` |
| `GET` | `/{provider}/callback` |
| `GET` | `/{provider}/start` |

### Role

| `GET` | `/api/v1/roles` |
| `POST` | `/api/v1/roles` |
| `DELETE` | `/api/v1/roles/{id}` |
| `PATCH` | `/api/v1/roles/{id}` |
| `POST` | `/api/v1/users/{userId}/role` |

### Search

| `GET` | `/api/v1/search` |

### Server

| `GET` | `/api/v1/servers` |
| `POST` | `/api/v1/servers` |
| `GET` | `/api/v1/servers/discover` |
| `POST` | `/api/v1/servers/join` |
| `DELETE` | `/api/v1/servers/{id}` |
| `PATCH` | `/api/v1/servers/{id}` |
| `DELETE` | `/api/v1/servers/{id}/domain` |
| `PUT` | `/api/v1/servers/{id}/domain` |
| `POST` | `/api/v1/servers/{id}/join-public` |
| `GET` | `/api/v1/servers/{id}/visibility` |
| `PATCH` | `/api/v1/servers/{id}/visibility` |
| `DELETE` | `/api/v1/servers/{serverId}/members/{userId}` |
| `POST` | `/api/v1/servers/{serverId}/members/{userId}/role` |
| `GET` | `/api/v1/space-by-host` |
| `GET` | `/api/v1/tls-check` |

### Setup

| `POST` | `/api/v1/setup` |
| `GET` | `/api/v1/setup/status` |

### SpaceAdmin

| `GET` | `/` |
| `POST` | `/` |
| `DELETE` | `/{id}` |
| `PUT` | `/{id}` |
| `GET` | `/{id}/branding` |
| `PUT` | `/{id}/branding` |
| `POST` | `/{id}/owner` |
| `GET` | `/{id}/servers` |
| `GET` | `/{id}/sso` |
| `PUT` | `/{id}/sso` |
| `GET` | `/{id}/users` |

### Upload

| `GET` | `/api/v1/files/{id}` |
| `POST` | `/api/v1/uploads` |
| `POST` | `/api/v1/uploads/voice` |

### User

| `GET` | `/api/v1/users/me` |
| `PATCH` | `/api/v1/users/me` |
| `PUT` | `/api/v1/users/me/password` |
| `GET` | `/api/v1/users/me/permissions` |
| `DELETE` | `/api/v1/users/me/sessions` |
| `GET` | `/api/v1/users/me/sessions` |
| `DELETE` | `/api/v1/users/me/sessions/{id}` |
| `GET` | `/api/v1/users/search` |

### Voice

| `GET` | `/api/v1/voice/credentials` |

---

Generated from `Outcome.Api/Endpoints/` — if you add an endpoint, this list is stale until
somebody regenerates it, and `/openapi` is not.
