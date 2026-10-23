# Quick start

Two ways in: run the published images, or build from this repo. Once it is up,
[user-guide.md](user-guide.md) covers what to do with it (in Russian).

## Run it (Docker)

The deployment kit is a separate, MIT-licensed repo that pulls prebuilt images — nothing is
compiled and there is no toolchain to install:

```bash
git clone https://github.com/Skayloo/Outcome.git outcome
cd outcome
cp .env.example .env      # then edit it — the file says which values must change
docker compose up -d
```

The first account you create becomes the **owner**. Registration is open after that; make it
invite-only, or close it, in the admin console → Server settings, and hand out codes from
Invites.

There is no mail. An account is made without a confirmation code, and a forgotten password is
set by an administrator: admin console → Users → the person's menu → Set password.

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

The backend needs Postgres, Redis and an S3 store (Garage) reachable. The fastest way is to start those from
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
| PostgreSQL | Everything durable. PgBouncer in front of it in production |
| Redis | Real-time fan-out between API replicas |
| Garage | Uploaded files (S3) |
| LiveKit | The voice/video SFU |

## Where to go next

- [deployment.md](deployment.md) — running it for real, behind TLS
- [server-configuration.md](server-configuration.md) — every setting the server reads
- [api.md](api.md) / [protocol.md](protocol.md) — the REST surface and the WebSocket messages
