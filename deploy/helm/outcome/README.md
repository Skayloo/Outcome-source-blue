# Outcome Helm chart

Deploys the whole stack (API + web + Postgres/Redis/MinIO/LiveKit) on Kubernetes with an
Ingress (cert-manager TLS), optional HPA, and bundled or external data services.

## Install
```bash
helm install outcome ./deploy/helm/outcome \
  --namespace outcome --create-namespace \
  --set ingress.host=chat.example.com \
  --set server.image.repository=ghcr.io/you/outcome-server \
  --set server.image.tag=v1 \
  --set frontend.image.repository=ghcr.io/you/outcome-frontend \
  --set frontend.image.tag=v1 \
  --set secrets.jwtKey=$(openssl rand -hex 32) \
  --set secrets.postgresPassword=$(openssl rand -hex 24) \
  --set secrets.minioAccessKey=outcome-$(openssl rand -hex 6) \
  --set secrets.minioSecretKey=$(openssl rand -hex 24) \
  --set secrets.livekitApiKey=LK$(openssl rand -hex 6) \
  --set secrets.livekitApiSecret=$(openssl rand -hex 24)
```
Better: put non-secret settings in a `my-values.yaml` and pass secrets via `--set` or an
`existingSecret`. Requires an ingress controller and (for auto-TLS) cert-manager with the
`ingress.tls.clusterIssuer` you name.

## Common overrides (`my-values.yaml`)
```yaml
ingress: { host: chat.example.com, tls: { clusterIssuer: letsencrypt-prod } }
server:  { replicas: 4, autoscaling: { enabled: true, maxReplicas: 12 } }
livekit: { replicas: 2, nodeIp: "" }          # hostIP per node; set an explicit IP if needed
postgres: { storage: 50Gi, storageClass: fast-ssd }
minio:    { storage: 100Gi }
```

## Bring your own data services
```yaml
postgres: { enabled: false, external: { host: my-pg.rds.aws, port: 5432, database: outcome, username: outcome } }
minio:    { enabled: false, external: { endpoint: s3.amazonaws.com, useSsl: "true" } }
redis:    { enabled: false, external: { url: my-redis:6379 } }
```
(The Postgres password / MinIO keys still come from the chart Secret or `existingSecret`.)

## Voice/video note
LiveKit media (ICE, UDP/TCP) does NOT flow through the Ingress. Pods run with `hostNetwork`
+ anti-affinity (one per node) and advertise each node's hostIP; open **tcp 7881** +
**udp 50000-50200** on those nodes and make sure browsers can reach their IPs. Only the
`wss` signaling rides the Ingress via the same-origin `/livekit` path.

## Uninstall
```bash
helm uninstall outcome -n outcome
# PVCs (postgres/minio data) are kept — delete them explicitly to wipe data.
```
