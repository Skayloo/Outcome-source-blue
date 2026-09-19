#!/bin/sh
# Start livekit-server, enabling its TURN/TLS relay only if the certificate is actually there.
#
# Why this exists rather than putting `turn:` straight in the config: livekit-server EXITS —
# "TURN tls cert required" — when turn.enabled is set and the file is missing. That is the
# normal state of a first boot, before Caddy has finished issuing, and of any boot where DNS
# for the turn host has not been pointed yet. Refusing to start would take voice down
# completely in order to add a fallback path to it, which is the wrong way round.
#
# So: certificate present → TURN on. Absent → a line in the log and voice as before.
set -e

: "${OUTCOME_DOMAIN:?OUTCOME_DOMAIN is required}"
HOST="turn.$OUTCOME_DOMAIN"
# 5349 is the registered TURNS port, which is exactly why it is worth being able to move:
# consumer routers with a SIP helper intercept 3478/5349 for their own VoIP stack and never
# forward them, silently. LiveKit both listens on this and advertises it to clients, so the
# external and internal port have to be the same number.
PORT="${TURN_TLS_PORT:-5349}"

# Caddy keeps certificates at <data>/caddy/certificates/<issuer>/<host>/<host>.crt. The issuer
# directory is named after the ACME endpoint and changes between staging and production (and
# has been renamed across Caddy versions), so glob it instead of hardcoding one.
CRT=$(ls "/caddy/caddy/certificates/"*"/$HOST/$HOST.crt" 2>/dev/null | head -1)
KEY=$(ls "/caddy/caddy/certificates/"*"/$HOST/$HOST.key" 2>/dev/null | head -1)

printf '%s\n' "$LIVEKIT_CONFIG" > /tmp/livekit.yaml

# An external TURN relay, advertised to clients as an ICE server. This is the path that makes
# voice work at all from outside: the SFU sits behind a router that rewrites the source address
# of inbound packets, and ICE — a protocol built entirely on address symmetry — cannot survive
# that. Against a relay both sides open OUTBOUND flows, so the router leaves the media path.
#
# It goes INSIDE the existing rtc: block, hence the insert rather than an append: a second
# top-level rtc: key would either be rejected or silently shadow the first one.
#
# Credentials are ephemeral (TURN REST): livekit signs "<expiry>:<participantID>" with the
# shared secret, so nothing long-lived is handed to a browser.
if [ -n "$TURN_RELAY_HOST" ]; then
  awk -v h="$TURN_RELAY_HOST" \
      -v p="${TURN_RELAY_PORT:-3478}" \
      -v pr="${TURN_RELAY_PROTOCOL:-udp}" \
      -v s="$TURN_RELAY_SECRET" '
    { print }
    /^rtc:/ && !seen {
      print "  turn_servers:"
      print "    - host: " h
      print "      port: " p
      print "      protocol: " pr
      print "      secret: " s
      seen = 1
    }
  ' /tmp/livekit.yaml > /tmp/livekit.yaml.new && mv /tmp/livekit.yaml.new /tmp/livekit.yaml
  echo "livekit: external TURN relay ${TURN_RELAY_HOST}:${TURN_RELAY_PORT:-3478}/${TURN_RELAY_PROTOCOL:-udp}"
fi

# A kill switch, because TURN is the one part of this file that can take voice down with it:
# it hands clients a relay whose media ports are published separately, so a mismatch there
# fails as "could not establish pc connection" with nothing wrong in the logs.
if [ "${TURN_ENABLED:-1}" = "0" ]; then
  echo "livekit: TURN disabled by TURN_ENABLED=0"
elif [ -n "$CRT" ] && [ -n "$KEY" ]; then
  cat >> /tmp/livekit.yaml <<EOF

turn:
  enabled: true
  domain: $HOST
  tls_port: $PORT
  cert_file: $CRT
  key_file: $KEY
EOF
  echo "livekit: TURN over TLS enabled for $HOST:$PORT"
else
  echo "livekit: no certificate for $HOST yet — starting WITHOUT TURN."
  echo "livekit: point $HOST at this server in DNS; Caddy issues on the next request,"
  echo "livekit: and TURN comes up when this container is next restarted."
fi

# LIVEKIT_CONFIG must go before exec: livekit-server prefers the config in that variable over
# the --config file, so leaving it set means the file we just wrote — turn block and all — is
# read by nobody. It fails silently: the log line above still says TURN is enabled, docker
# still publishes the port, and the only symptom is that nothing is listening behind it.
unset LIVEKIT_CONFIG
exec /livekit-server --config /tmp/livekit.yaml "$@"
