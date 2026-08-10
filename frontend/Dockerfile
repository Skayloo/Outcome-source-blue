# syntax=docker/dockerfile:1

# ── Build the React app ──────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
# RED (private, E2EE) or BLUE (public self-hosted, no encryption). vite.config.ts aliases
# the E2EE modules to plaintext stand-ins for blue, so the crypto never enters the bundle.
ARG OUTCOME_EDITION=blue
RUN OUTCOME_EDITION=${OUTCOME_EDITION} npm run build

# ── Serve via nginx (also reverse-proxies the API/WS to the backend) ─────────
FROM nginx:alpine
# openssl mints the self-signed HTTPS cert at container start (see entrypoint script).
RUN apk add --no-cache openssl
# Rendered by the official image's envsubst entrypoint: only env vars set below are
# substituted; nginx runtime vars ($host, $http_upgrade, …) pass through untouched.
COPY nginx.conf /etc/nginx/templates/default.conf.template
# Runs before nginx boots (official image executes /docker-entrypoint.d/*.sh in order)
# so `listen 443 ssl` has a cert to serve — enables a secure context on LAN IPs, which
# getUserMedia/getDisplayMedia (mic/camera/screen share) require.
COPY docker-entrypoint.d/40-gen-cert.sh /docker-entrypoint.d/40-gen-cert.sh
# Writes /config.js (runtime endpoint config) from the OUTCOME_* env vars before nginx boots.
COPY docker-entrypoint.d/50-outcome-config.sh /docker-entrypoint.d/50-outcome-config.sh
# Strip any CR (Windows checkouts can add CRLF, which breaks the #!/bin/sh shebang) + make executable.
RUN sed -i 's/\r$//' /docker-entrypoint.d/40-gen-cert.sh /docker-entrypoint.d/50-outcome-config.sh \
    && chmod +x /docker-entrypoint.d/40-gen-cert.sh /docker-entrypoint.d/50-outcome-config.sh
# Docker Compose defaults. On Kubernetes override DNS_RESOLVER with the cluster DNS
# service IP (kubectl -n kube-system get svc kube-dns) and keep BACKEND_UPSTREAM
# pointing at the `server` Service.
# OUTCOME_* are the runtime endpoint overrides for a per-service subdomain ingress; leave EMPTY
# for the default same-origin deployment (the SPA then derives everything from its own origin).
# LANDING_HOST names the ONE public domain that answers "/" with the static landing page
# instead of the app (the app then lives at /app). "-" is not a legal hostname, so the default
# matches nothing and "/" keeps serving the app — which is what a self-hosted install wants.
ENV DNS_RESOLVER=127.0.0.11 \
    BACKEND_UPSTREAM=server:5000 \
    LANDING_HOST="-" \
    OUTCOME_API_BASE="" \
    OUTCOME_WS_URL="" \
    OUTCOME_LIVEKIT_URL=""
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
