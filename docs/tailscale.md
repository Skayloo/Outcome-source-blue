# Tailscale (no port forwarding)

Tailscale is a WireGuard mesh: every device gets a stable `100.x.y.z` address and reaches every
other one directly, through CGNAT and strict firewalls alike. For a private instance whose
users you know, it removes the entire port-forwarding and certificate problem.

The trade is that everyone who uses the instance needs to be on the tailnet. That is fine for a
team and wrong for anything with guests — a guest voice link cannot be opened by someone who is
not on the VPN.

## Setup

1. Install Tailscale on the server and on each client, and sign them into the same tailnet (or
   share the machine from the admin console).
2. Note the server's tailnet address, `100.x.y.z`.
3. Point the clients at `http://100.x.y.z:8080` — the frontend container's plain HTTP port.

## The one thing that will surprise you

**Microphone, camera and screen share will not work over a bare `http://100.x.y.z` address.**
The browser requires a secure context, and it does not care that WireGuard already encrypted
the link. Text and presence work; calls do not.

Two ways out:

- Set `TLS_SAN=100.x.y.z` on the frontend container. It mints a self-signed certificate
  covering that address at start; accept it once per browser and `getUserMedia` is allowed.
- Or use Tailscale's own HTTPS (`tailscale cert` / MagicDNS), which issues a real certificate
  for the machine's tailnet name — no warning to accept.

Either way, `LIVEKIT_NODE_IP` should be the tailnet address too, so media is advertised on the
network the clients are actually on.
