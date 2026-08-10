# Reaching the server from outside

For people outside your LAN to use the instance, the router has to forward traffic to it.

## What to forward

| External | → internal | Protocol | |
| --- | --- | --- | --- |
| 443 | 443 | TCP | The site itself |
| 80 | 80 | TCP | ACME. Closing it means no certificate renewals |
| 7882 | 7882 | **UDP** | LiveKit media. This is the one people forget, and forgetting it is why a call connects and carries nothing |
| 7881 | 7881 | TCP | Media fallback where UDP is blocked. Works, sounds worse |

Router UIs file this under "Port forwarding", "NAT" or "Virtual servers" depending on the
vendor. The internal address must be the machine's LAN IP, and that address needs to be static
— a DHCP lease that moves silently breaks every rule at once.

## The public address

`LIVEKIT_NODE_IP` in `.env` must be the **public** IP, because it is handed to browsers for the
media connection, which does not go through the HTTP proxy. An internal address there produces
exactly the symptom above: connected, silent.

## Changing IP

If the address is dynamic, put a dynamic-DNS hostname in front of it (DuckDNS, No-IP,
Cloudflare's API) and point the domain at that. Certificates are issued for the name, so the
name is what has to stay stable — not the address.

## Firewall

On the host itself, allow the same ports. Docker usually punches its own rules through, but a
host firewall configured separately (ufw, firewalld) is the usual reason a correctly forwarded
port still refuses connections.

## If you would rather not

[tailscale.md](tailscale.md) — no forwarding at all, at the price of everyone needing the VPN.
