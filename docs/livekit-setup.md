# LiveKit

Voice, video and screen share go through a LiveKit SFU. The deployment kit runs one alongside
the API; this page is what you need to know when it misbehaves, which it does in a small number
of very specific ways.

## What the server needs

Three settings, all under `Voice` (see [server-configuration.md](server-configuration.md)):

| | |
| --- | --- |
| `LiveKitApiKey` / `LiveKitApiSecret` | Shared with the SFU. Voice is simply off without both |
| `LiveKitUrl` | What the **browser** is told. Behind TLS: `wss://<domain>/livekit` |
| `LiveKitInternalUrl` | What the **API** uses: `ws://livekit:7880` on the compose network |
| `NodeIp` | The SFU's **public** address, advertised to browsers for media |

The SFU's own config carries the matching key pair:

```yaml
keys:
  <api key>: <api secret>
rtc:
  udp_port: 7882
  tcp_port: 7881
  use_external_ip: true
```

## The secret must be at least 32 characters

The SDK refuses shorter ones outright — `apiSecret must be at least 256 bits long`. It throws
when a token is minted, which is when somebody tries to join a call, so a too-short secret
looks like "voice is broken" rather than "configuration is invalid". If joining returns a 500,
check the length before anything else.

## Signalling goes through the API, media does not

The browser reaches signalling at `/livekit` on the same origin, proxied by the frontend to the
SFU. That exists so the client never touches the SFU's own port directly: a different port
means either mixed content or a second certificate, and with a self-signed setup the browser
blocks it silently.

Auth on those routes is the **LiveKit JWT**, not the Outcome session — the proxy forwards the
`Authorization` header through and the SFU decides.

**Media does not use that path at all.** It is a direct UDP connection from the browser to
`NodeIp:7882`. That is why an internal `NodeIp` produces a call that reports "connected" and
carries no audio: signalling succeeded over the proxy, media had nowhere to go.

## Ports

7882/UDP is the one that matters. If it is blocked, LiveKit falls back to 7881/TCP — which
works, and is measurably worse under loss. Open the UDP one.

## TURN: off for now, and what it will cost to turn back on

The embedded relay is off (`TURN_ENABLED=0`). It was added to survive networks that mangle
UDP — a VPN tunnel dropping calls every ten seconds — and it took voice down for everyone
instead. Worth having eventually; not worth having on the terms it was first deployed with.

The trap is that **the relay's media does not travel on the TLS port you publish.** LiveKit
listens on 11802 for the TURN handshake and then allocates media on 30000–40000, which docker
never published. While the server sat in the router's DMZ that range happened to be reachable
and the thing worked, including on the day it was deployed. DMZ came off, the range went dark,
and every client that took a relay candidate hit a ten-second ICE timeout with nothing wrong
in any log: signalling fine, tokens fine, `participant_connection_aborted` and no reason given.

So bringing it back means three things together, and any one of them alone leaves it broken:

1. Narrow the relay range — `turn.relay_range_start` / `relay_range_end`, say 30000–30049.
2. Publish that range from the container, and forward it on whatever sits in front.
3. Verify with the DMZ **closed**. An open DMZ makes a misconfigured relay look like a working
   one, which is exactly how this shipped.

Mind the cost of step 2 on a host with docker's userland proxy: one process per published
port. Fifty ports, fifty processes.

**Until then, if UDP is being mangled, 7881/TCP already covers it.** It is published,
reachable, and LiveKit falls back to it on its own — the same failure handled with nothing new
to operate.

## Guests

A guest link mints a token for an anonymous visitor. The display name is suffixed server-side
so a visitor cannot impersonate a member, and the endpoint is rate limited hard, per IP and
globally: minting media tokens for anonymous callers is the whole attack surface.

In the RED edition members and guests share a room key derived from the link code, so a keyless
guest is still audible. BLUE has no frame encryption at all — see
[encryption.md](encryption.md) — and a guest joins the same way a member does.

## Noise suppression is not LiveKit's

The microphone is processed before LiveKit sees it: a DeepFilterNet model runs in the browser
and the SFU forwards whatever comes out. Nothing about it is configured here, and turning
LiveKit's own audio processing on top of it makes things worse, not better — two filters in
series each chewing on the other's output.

Server-side speaker detection *is* LiveKit's, and it is what drives the speaking indicator for
remote participants:

```yaml
audio:
  active_level: 45
  min_percentile: 20
  update_interval: 300
  smooth_intervals: 3
```

## Checking it

`/health` on the API reports whether voice is configured. Beyond that the quickest test is a
guest link: it exercises token minting, the proxy and media in one go, without an account.
