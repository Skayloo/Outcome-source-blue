#!/bin/sh
# Emit /config.js so the SPA reads per-service endpoints at RUNTIME — one image works on any
# domain. Empty vars => the app falls back to same-origin (the default single-origin deploy).
# See src/lib/runtimeConfig.ts. Runs before nginx (official image executes docker-entrypoint.d/*).
set -e

OUT=/usr/share/nginx/html/config.js
cat > "$OUT" <<EOF
window.__OUTCOME__ = {
  apiBase: "${OUTCOME_API_BASE}",
  wsUrl: "${OUTCOME_WS_URL}",
  livekitUrl: "${OUTCOME_LIVEKIT_URL}"
};
EOF

echo "[outcome-config] wrote $OUT (apiBase='${OUTCOME_API_BASE}' wsUrl='${OUTCOME_WS_URL}' livekitUrl='${OUTCOME_LIVEKIT_URL}')"
