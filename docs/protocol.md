# WebSocket protocol

One socket per client at `/api/v1/ws`. It carries everything real-time: messages, presence,
typing, voice state and call signalling.

## Authenticating

The socket authenticates **in-band** — the HTTP upgrade carries no credentials, and the route
deliberately has no auth middleware. The first frame must be:

```json
{"type": "auth", "payload": {"token": "<jwt>", "last_seq": 0, "server_id": 0}}
```

Anything else first is refused. `last_seq` asks for a replay of what was missed; `server_id`
picks the active space for this connection.

## Frame shape

```json
{"type": "<name>", "payload": { ... }, "req_id": "optional"}
```

`req_id` is echoed on the reply, which is how a client correlates a response to the send that
caused it. Payload keys are snake_case, matching the REST API.

## Messages

**client → server** (24): `call_accept`, `call_cancel`, `call_decline`, `call_offer`, `chat_delete`, `chat_edit`, `chat_send`, `listen`, `ping`, `presence_update`, `reaction_add`, `reaction_remove`, `read`, `switch_server`, `typing_start`, `voice_camera`, `voice_deafen`, `voice_join`, `voice_key_request`, `voice_key_share`, `voice_leave`, `voice_mute`, `voice_screenshare`, `voice_token_refresh`

**server → client** (35): `auth_error`, `auth_ok`, `call_accepted`, `call_cancelled`, `call_declined`, `call_incoming`, `channel_create`, `channel_delete`, `channel_update`, `chat_deleted`, `chat_edited`, `chat_message`, `chat_send_ok`, `error`, `friend_accepted`, `friend_removed`, `friend_request`, `member_ban`, `member_delete`, `member_join`, `member_leave`, `member_update`, `pong`, `presence`, `reaction_update`, `replay_done`, `typing`, `voice_config`, `voice_key_first`, `voice_key_regime`, `voice_key_request`, `voice_key_share`, `voice_leave`, `voice_state`, `voice_token`

## Things that are easy to get wrong

- **`chat_send` carries `channel_id` and `content`**, plus optional `reply_to`,
  `forwarded_from` and `attachments` (ids from a prior upload). Sending a message is a socket
  operation, not a REST one — there is no `POST /messages`.
- **The frame list above is generated from `WsFrames.cs`.** The client's mirror of these types
  lives in `frontend/src/lib/protocolTypes.ts` and nothing checks that the two agree. Change
  one, change the other.
- **Voice tokens arrive over the socket**, not from REST: `voice_join` gets you a
  `voice_token` frame with the LiveKit token and the URL to use.
- **Presence and typing are best-effort.** They are not replayed, and a client that reconnects
  rebuilds them from the state frames it gets on connect.

## Editions

The RED build additionally exchanges room keys for voice frame encryption over this socket.
The BLUE build has no such frames at all — they are removed from the server, not merely
unused. See [encryption.md](encryption.md).
