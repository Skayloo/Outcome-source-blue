# Deploying Outcome

Pick the target that matches your infrastructure. All of them run the same six pieces:
**Caddy/Ingress (edge TLS) → frontend (nginx) → API ×N → Postgres · Redis · MinIO · LiveKit**,
with every secret externalized and database migrations self-serializing behind a Postgres
advisory lock (so any number of API replicas can boot at once).

| Target | Path | Use when |
|---|---|---|
| **Docker Compose** (prod) | [`compose/`](compose/) | One host / VPS. Caddy auto-HTTPS for a domain. |
| **Docker Swarm** | [`swarm/`](swarm/) | A small multi-node Swarm cluster with real secrets + rolling updates. |
| **Kubernetes (Helm)** | [`helm/outcome/`](helm/outcome/) | A cluster. Ingress + cert-manager TLS, optional HPA, bundled or managed data services. |
| Kubernetes (raw YAML) | [`k8s/`](k8s/) | Plain manifests / kustomize, no Helm. |

## Two rules that apply everywhere
1. **Regenerate every secret** before a real deploy (JWT key, DB password, MinIO keys,
   LiveKit key+secret). Never ship the example values.
2. **LiveKit media is special.** Voice/video RTP (ICE, UDP + TCP 7881) goes **directly**
   from the browser to LiveKit's advertised IP — it does NOT pass through Caddy/Ingress.
   So LiveKit must advertise a browser-reachable IP (host public IP / node hostIP) and its
   media ports must be open. Only the `wss` **signaling** rides the L7 proxy via `/livekit`.

## Build & push the two app images
```bash
docker build -t <registry>/outcome-server:<tag>   ServerDotnet
docker build -t <registry>/outcome-frontend:<tag> frontend
docker push <registry>/outcome-server:<tag>
docker push <registry>/outcome-frontend:<tag>
```
Then point each target's image refs at them. See each subfolder's README for the rest.
