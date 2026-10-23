# Deployment

The supported way to run Outcome is the deployment kit —
[github.com/Skayloo/Outcome](https://github.com/Skayloo/Outcome). It is one compose file plus
prebuilt images; nothing is built from source. This page covers what the kit does not: the
shape of the stack, the decisions that bite, and how we run it ourselves.

The source those images are built from is published too, at
[Outcome-source-blue](https://github.com/Skayloo/Outcome-source-blue) — so the claims on this
page can be checked rather than taken on trust: no telemetry. It is free software under the GNU AGPL v3: you may run, change and redistribute
it, and build your own images from it.

## The stack

| Service | |
| --- | --- |
| `caddy-docker-proxy` | Edge TLS. Certificates are issued automatically per host from the container labels |
| `frontend` | nginx serving the web client, and reverse-proxying `/api`, `/livekit` and `/uploads` to the API so the browser sees one origin |
| `server` | The API. Stateless and replicated |
| `pgbouncer` → `postgres` | Runtime queries ride the pooler; migrations must not |
| `redis` | Real-time fan-out between API replicas |
| `garage` | Uploaded files — Garage, an S3 server (MinIO until 1.31.79; its images are no longer published) |
| `livekit` | The voice/video SFU |

Only Caddy and LiveKit publish ports. Postgres, Redis, Garage and the API are reachable on the compose
network and nowhere else.

## Before the first start

Generate every secret. `.env.example` marks the ones that must change; reusing the sample
values is the same as having none. At minimum: `POSTGRES_PASSWORD`, `JWT_KEY`,
`GARAGE_RPC_SECRET`, `GARAGE_ACCESS_KEY`/`GARAGE_SECRET_KEY` (the key id is `GK` + 24 hex characters,
the secret 64 hex — Garage refuses other shapes), `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.

`LIVEKIT_API_SECRET` must be **at least 32 characters**. The SDK rejects anything shorter with
`apiSecret must be at least 256 bits long`, and it fails at the moment somebody tries to join a
call rather than at startup.

`LIVEKIT_NODE_IP` must be the server's **public** IP. It is advertised to browsers for the
media connection, which bypasses the HTTP proxy entirely — an internal address here produces a
call that connects and carries no audio.

## Ports

| | |
| --- | --- |
| 80, 443 | Caddy. 80 is also the ACME challenge, so it cannot be closed if you want certificates |
| 7882/udp | LiveKit media. Open this |
| 7881/tcp | LiveKit media fallback when UDP is blocked. It works, and it is worse |
| 5349/tcp | TURN over TLS (`TURN_TLS_PORT`), for networks that block both of the above. Needs DNS for `turn.<domain>` |

Everything else stays inside.

## TLS

Caddy handles it from the labels — no configuration beyond the domain. If the deployment
cannot reach the ACME endpoints (some ISPs filter them), issue through an HTTP proxy: set
`HTTP_PROXY`/`HTTPS_PROXY` **on the Caddy container only**, with `NO_PROXY` covering the
upstreams and private ranges, so application traffic never touches it.

Certificates renew every 60 days. A proxy that quietly dies takes the renewal with it and
nothing complains until the certificate expires.

## Secure context

Microphone, camera and screen share require HTTPS or `localhost`. Over `http://<lan-ip>` the
browser refuses `getUserMedia` and the UI reports a call that has no audio. For a LAN box
without a domain, set `TLS_SAN` on the frontend container: it mints a self-signed certificate
covering those names at start, and the browser will accept it once you do.

## Scaling

The API is stateless — raise `SERVER_REPLICAS`. Redis carries events between them, PgBouncer
multiplexes their connections down to a handful of Postgres backends, and nginx resolves the
`server` name per request so new replicas join without a restart.

The one piece that does not scale horizontally out of the box is LiveKit; a single SFU handles
a surprising number of rooms, and past that it wants its own cluster.

## Backups

```bash
docker compose exec postgres pg_dump -U outcome -Fc outcome > outcome-$(date +%F).dump
```

That plus the Garage volumes (`garage_data`, `garage_meta`) is the whole state. Back up `.env` as well — losing `JWT_KEY` signs
everyone out.

## Upgrading

Bump `OUTCOME_TAG` in `.env`, then `docker compose pull && docker compose up -d`. Migrations
run at startup, against Postgres directly.

**From MinIO (1.31.78 and earlier):** files now live in Garage. An install that ran MinIO keeps
its image and its volume; the deployment kit's README ("Upgrading from MinIO") copies every file
across with rclone under `--profile migrate` — nothing is deleted, and the old volume is removed
by hand once the files open.


## Already running a web server on 80/443?

Switch the kit's Caddy off and point your own proxy at the web app — the deployment kit's README
shows the override file for both cases (a proxy on the host, a proxy in Docker) and the
settings the proxy needs: WebSocket upgrades, 110 MB bodies, `X-Forwarded-For`.

## Forgotten passwords

The server sends no e-mail. An administrator sets a new password in the admin console → Users →
the person's menu → Set password; every session of that person ends, and the password is theirs
to change afterwards in their profile.
