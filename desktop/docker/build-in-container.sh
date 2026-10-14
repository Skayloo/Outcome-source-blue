#!/bin/bash
# Runs inside electronuserland/builder:22-wine-01.25 — wine 9; the :wine tag carries wine 11,
# which aborts at start under the Mac's amd64 emulation. See desktop/README.md, "Building the
# Windows and Linux packages on a Mac". /src = scratch copy (frontend + desktop), read
# from; the build itself happens on the container's own filesystem (/build) because npm and
# electron-builder over a macOS bind mount under amd64 emulation are painfully slow.
# Artifacts are copied back to /src/out at the end.
set -euo pipefail
STEP="${1:-all}"

if [ "$STEP" = "all" ] || [ "$STEP" = "prep" ]; then
  rm -rf /build && mkdir -p /build
  cp -a /src/frontend /build/frontend
  cp -a /src/desktop /build/desktop
  echo "── node $(node --version), npm $(npm --version)"
  cd /build/frontend && npm ci --no-audit --no-fund
  cd /build/desktop && npm ci --no-audit --no-fund
fi

if [ "$STEP" = "all" ] || [ "$STEP" = "sync" ]; then
  cd /build/desktop && node scripts/sync-web.mjs
fi

if [ "$STEP" = "all" ] || [ "$STEP" = "linux" ]; then
  cd /build/desktop && npx electron-builder --linux --publish never
fi

if [ "$STEP" = "all" ] || [ "$STEP" = "win" ]; then
  cd /build/desktop && npx electron-builder --win --publish never
fi

if [ "$STEP" = "all" ] || [ "$STEP" = "collect" ]; then
  rm -rf /src/out && mkdir -p /src/out
  cd /build/desktop/release && ls -la
  cp -a /build/desktop/release/. /src/out/
fi
