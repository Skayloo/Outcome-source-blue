# Outcome — Docker Swarm

Runs the full stack on a Swarm cluster with real **Swarm secrets**, rolling updates
(start-first + auto-rollback), and Caddy edge TLS. API replicas scale freely; media
(LiveKit) is pinned to one node.

## 1. Prereqs
- An initialised Swarm (`docker swarm init`), your app images **pushed to a registry**
  (Swarm can't build), and a domain pointing at the ingress.
- Firewall open on the ingress for **80, 443** and on the LiveKit node for **7881/tcp + 55000-55100/udp**.

## 2. Label nodes (durable storage + media)
```bash
docker node update --label-add pgdata=true    <db-node>
docker node update --label-add miniodata=true <storage-node>
docker node update --label-add livekit=true   <media-node>   # its public IP = LIVEKIT_NODE_IP
```

## 3. Create secrets (regenerate every value)
```bash
printf %s "$(openssl rand -hex 32)" | docker secret create jwt_key -
printf %s "$(openssl rand -hex 24)" | docker secret create postgres_password -
printf %s "outcome-$(openssl rand -hex 6)" | docker secret create minio_access_key -
printf %s "$(openssl rand -hex 24)" | docker secret create minio_secret_key -

LK_KEY="LK$(openssl rand -hex 6)"; LK_SECRET="$(openssl rand -hex 24)"
printf %s "$LK_KEY"            | docker secret create livekit_api_key -
printf %s "$LK_SECRET"         | docker secret create livekit_api_secret -
printf '%s: %s' "$LK_KEY" "$LK_SECRET" | docker secret create livekit_keys -   # LiveKit key_file format
```
> `livekit_keys` MUST equal `"<livekit_api_key>: <livekit_api_secret>"` — the API signs
> tokens with the key/secret and LiveKit validates them against key_file.

## 4. Deploy
```bash
export OUTCOME_DOMAIN=chat.example.com
export ACME_EMAIL=admin@example.com
export LIVEKIT_NODE_IP=203.0.113.10          # the media node's public IP
export SERVER_IMAGE=ghcr.io/you/outcome-server:v1
export FRONTEND_IMAGE=ghcr.io/you/outcome-frontend:v1
export SERVER_REPLICAS=3

docker stack deploy -c docker-stack.yml outcome
docker stack services outcome
```
Open `https://chat.example.com` and finish first-run setup.

## Updating
```bash
export SERVER_IMAGE=ghcr.io/you/outcome-server:v2
docker stack deploy -c docker-stack.yml outcome   # start-first rolling update, auto-rollback on failure
```

## Notes
- **LiveKit media on Swarm** is the fiddly part: the routing mesh SNATs, which breaks
  WebRTC. This stack pins LiveKit to one labelled node (`replicas: 1`, host-mode TCP) so
  media reaches `LIVEKIT_NODE_IP` directly. For serious multi-region voice, run
  `livekit-server` **standalone** (plain `docker run --network host`) on each media host
  and point `OUTCOME_Voice__LiveKitInternalUrl` at it — LiveKit clusters over Redis.
- **Backups:** the `pgdata` and `minio_data` volumes live on their pinned nodes — snapshot
  those. Redis is disposable.
- Prefer a managed Postgres / S3 in production; drop those services and repoint the
  `ConnectionStrings__Postgres` / `OUTCOME_Minio__*` config.
