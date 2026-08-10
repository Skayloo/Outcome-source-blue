# Outcome on Kubernetes

```bash
# 1. Build & push images
docker build -t ghcr.io/YOU/outcome-server:v1   ServerDotnet
docker build -t ghcr.io/YOU/outcome-frontend:v1 frontend
docker push ghcr.io/YOU/outcome-server:v1 && docker push ghcr.io/YOU/outcome-frontend:v1

# 2. Point kustomization.yaml `images:` at them, regenerate 01-secrets.yaml values

# 3. Apply
kubectl apply -k deploy/k8s
```

How replication works (same as `docker-compose.scale.yml`):

| Concern | Mechanism |
|---|---|
| WS broadcast / DM delivery / kick across API replicas | Redis pub/sub backplane (`outcome:bus`) |
| Reconnect replay + global frame sequence | Redis (`outcome:seq`, `outcome:replay:{server}`) |
| 2FA challenges, admin log-stream tickets | Redis |
| Migration race between replicas | Postgres advisory lock |
| LiveKit room routing between SFU nodes | LiveKit's built-in Redis mode |
| HTTP/WS load-balancing | `server` Service (kube-proxy); frontend nginx resolves per-request |

Things to adjust for YOUR cluster:

- **`01-secrets.yaml`** — regenerate every value (`openssl rand -hex 32`).
- **`07-frontend.yaml`** — `DNS_RESOLVER` = your cluster DNS Service IP
  (`kubectl -n kube-system get svc kube-dns`), and the Ingress `host`.
- **`06-server.yaml`** — `OUTCOME_Voice__LiveKitUrl` = the public wss URL browsers use.
- **`05-livekit.yaml`** — LiveKit uses `hostNetwork` (one pod per node via anti-affinity);
  open `udp 50000-50200` + `tcp 7880/7881` on those hosts, and set
  `rtc.use_external_ip: true` when nodes sit behind NAT.
- Postgres/MinIO here are single-replica starters — swap for managed Postgres/S3
  (the app only needs `ConnectionStrings__Postgres` and `OUTCOME_Minio__*`) for real HA.
- Scale the API with `kubectl -n outcome scale deploy/server --replicas=N` — no other
  changes needed.
