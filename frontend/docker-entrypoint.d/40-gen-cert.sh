#!/bin/sh
# Optional self-signed HTTPS for DIRECT frontend access (no edge proxy).
#
# Browsers only expose getUserMedia / getDisplayMedia (mic, camera, screen share) in a
# SECURE CONTEXT — HTTPS, or localhost/127.0.0.1. Over a plain-HTTP LAN IP
# (http://192.168.x.x) navigator.mediaDevices is hidden, so voice/video/screenshare
# silently fail. Serving HTTPS (even self-signed) makes that origin a secure context.
#
# This runs ONLY when TLS_SAN is set (comma-separated hosts/IPs the cert should cover).
# It generates a cert and drops a `listen 443 ssl` snippet into /etc/nginx/tls/ which the
# main server block includes. Leave TLS_SAN UNSET when you sit behind Caddy or a
# Kubernetes Ingress — those terminate TLS with a real cert and reach this frontend over
# plain HTTP on :80, which is correct: secure context is decided by the browser-facing
# origin (the edge's https URL), not by internal, unencrypted cluster hops.
set -e

TLS_DIR=/etc/nginx/tls
CERT_DIR=/etc/nginx/certs
mkdir -p "$TLS_DIR" "$CERT_DIR"

# TLS disabled (behind an edge proxy): ensure no 443 listener and exit — HTTP only.
if [ -z "$TLS_SAN" ]; then
  rm -f "$TLS_DIR"/ssl.conf
  echo "[gen-cert] TLS_SAN unset — serving HTTP only (TLS is terminated upstream)."
  exit 0
fi

CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"
STAMP="$CERT_DIR/.san"

# (Re)generate only when the cert is missing or the requested SAN changed.
if [ ! -f "$CRT" ] || [ ! -f "$KEY" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$TLS_SAN" ]; then
  # Build the openssl SAN list: digits+dots => IP:, anything else => DNS:.
  LINE=""
  OLDIFS=$IFS
  IFS=','
  for e in $TLS_SAN; do
    e=$(printf %s "$e" | tr -d ' ')
    [ -z "$e" ] && continue
    case "$e" in
      *[!0-9.]*) LINE="$LINE,DNS:$e" ;;
      *)         LINE="$LINE,IP:$e" ;;
    esac
  done
  IFS=$OLDIFS
  LINE="${LINE#,}"

  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$KEY" -out "$CRT" \
    -subj "/CN=outcome.local" \
    -addext "subjectAltName=$LINE" >/dev/null 2>&1
  printf %s "$TLS_SAN" > "$STAMP"
  echo "[gen-cert] self-signed TLS cert ready for: $LINE"
fi

# Enable the HTTPS listener (included by the main server block).
cat > "$TLS_DIR/ssl.conf" <<EOF
listen 443 ssl;
ssl_certificate     $CRT;
ssl_certificate_key $KEY;
ssl_protocols TLSv1.2 TLSv1.3;
EOF
