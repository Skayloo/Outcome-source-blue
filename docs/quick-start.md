# Quick start

Two ways in: run the published images, or build from this repo.

## Run it (Docker)

The deployment kit is a separate, MIT-licensed repo that pulls prebuilt images — nothing is
compiled and there is no toolchain to install:

```bash
git clone https://github.com/Skayloo/Outcome.git outcome
cd outcome
cp .env.example .env      # then edit it — the file says which values must change
docker compose up -d
```

The first account you create becomes the **owner**. After that, registration is by invite:
admin console → Invites.

Mail is optional. With `EMAIL_HOST` unset the server prints confirmation codes to its own log
(`docker compose logs server`), which is enough to get going and not enough to hand to real
users.

> Microphone, camera and screen share need a **secure context** — `http://localhost` or real
> HTTPS. Over `http://<lan-ip>` the browser refuses `getUserMedia`, and the call connects to
> silence. The kit fronts everything with Caddy and a real certificate; for a LAN box, set
> `TLS_SAN` on the frontend container so it serves its own self-signed cert.

## Build it (this repo)

Backend commands from `ServerDotnet/`, frontend from `frontend/`.

```bash
# Backend — .NET 10
cd ServerDotnet
dotnet build
dotnet run --project Outcome.Api        # listens on :5000

# Frontend — Node 20
cd frontend
npm install
npm run dev                             # Vite dev server, proxies /api to :5000
```

The backend needs Postgres, Redis and MinIO reachable. The fastest way is to start those from
the deployment kit's compose file and point the local server at them — see
[server-configuration.md](server-configuration.md) for the environment variables, which is how
every deployment sets them (`OUTCOME_Section__Key`).

Voice additionally needs a LiveKit server and a key/secret pair. The secret must be at least 32
characters; the SDK rejects shorter ones outright.

## What runs where

| | |
| --- | --- |
| `ServerDotnet/` | The API: REST, the WebSocket, voice signalling. One process, horizontally scalable |
| `frontend/` | The web client — React + Vite, served by nginx in production |
| `mobile/` | The iOS app — Flutter |
| PostgreSQL | Everything durable. PgBouncer in front of it in production |
| Redis | Real-time fan-out between API replicas |
| MinIO | Uploaded files |
| LiveKit | The voice/video SFU |

## Where to go next

- [deployment.md](deployment.md) — running it for real, behind TLS
- [server-configuration.md](server-configuration.md) — every setting the server reads
- [encryption.md](encryption.md) — what each edition does and does not protect
- [api.md](api.md) / [protocol.md](protocol.md) — the REST surface and the WebSocket messages
