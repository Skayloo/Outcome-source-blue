# Outcome — production Docker Compose

Single-host production deployment: **Caddy** (auto-HTTPS) → **frontend** → **API ×N** →
**Postgres · Redis · MinIO · LiveKit**. All secrets live in `.env`; internal services are
never published on the host.

## 1. Prerequisites
- A host with Docker + Compose v2, a public IP, and ports **80, 443, 7881/tcp, 55000-55100/udp** open.
- A domain (`chat.example.com`) with an A/AAAA record pointing at the host — required for the Let's Encrypt cert.

## 2. Configure
```bash
cd deploy/compose
cp .env.example .env
# Fill EVERY secret (openssl rand -hex 32, …), set OUTCOME_DOMAIN, ACME_EMAIL,
# and LIVEKIT_NODE_IP = this host's public IP. Point SERVER_IMAGE / FRONTEND_IMAGE
# at your registry (or build locally, below).
```

## 3. Build & run
```bash
# Build the two app images (or pull prebuilt ones and skip this):
docker compose -f docker-compose.prod.yml build

docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```
Open `https://chat.example.com`, complete first-run setup (owner account).

## 4. Scale the API
```bash
# Edit SERVER_REPLICAS in .env, then:
docker compose -f docker-compose.prod.yml up -d
```
API replicas are stateless (all shared state is in Redis); migrations self-serialize
behind a Postgres advisory lock, so booting many at once is safe.

## Real client IPs, rate limits & DDoS

The API resolves the real client address from `X-Forwarded-For`, but **only via trusted
proxies** — by default loopback + RFC1918 (i.e. Caddy on the compose network). Everything
keyed on IP (per-IP rate limits, per-IP WebSocket caps, audit/ban records) depends on this.

- **Own proxy elsewhere?** Set `OUTCOME_TrustedProxies` to comma-separated CIDRs.
- **Cloudflare in front (recommended for a public launch):** orange-cloud the domain
  (HTTP + WebSockets proxy fine), then either configure Caddy `trusted_proxies` for
  Cloudflare's ranges or append those ranges to `OUTCOME_TrustedProxies` — otherwise every
  visitor appears to be a Cloudflare edge IP and shares one rate-limit bucket.
- **Voice cannot hide behind Cloudflare**: LiveKit media is raw UDP straight to
  `LIVEKIT_NODE_IP`. For a launch expecting hostile traffic, host LiveKit in a datacenter
  with L3/L4 DDoS filtering (e.g. Hetzner) — never on a home connection.
- Registration/login also carry **instance-wide** ceilings (600 and 1200 per minute) so a
  botnet can't saturate password hashing; concurrent WebSockets are capped per IP
  (`OUTCOME_Limits__WsMaxPerIp`, default 64).

## Notes
- **Voice/video media** (LiveKit RTP) goes **directly** browser→host on `7881/tcp` +
  `7882/udp` (single muxed media port) — it does NOT pass through Caddy. `LIVEKIT_NODE_IP`
  must be the host's reachable public IP and those ports must be open. Only the `wss`
  signaling rides Caddy.
- **No domain / LAN only?** Drop the `caddy` service and publish the frontend directly,
  setting `TLS_SAN` on it to your host/IP (self-signed HTTPS). See the root `docker-compose.yml`.
- **Managed data services?** Point `ConnectionStrings__Postgres` / `OUTCOME_Minio__*` /
  `OUTCOME_Redis__Url` at external Postgres / S3 / Redis and remove those services.
- **Backups:** snapshot the `pgdata` (database) and `minio_data` (uploads) volumes. Redis
  is pure cache — no backup needed.
