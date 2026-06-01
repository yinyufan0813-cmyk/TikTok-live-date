#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

PORT="${GMVMAX_MOBILE_PORT:-8788}"
HOSTNAME="${GMVMAX_TAILSCALE_HOSTNAME:-youmigmvmax}"
TOKEN="${GMVMAX_MOBILE_TOKEN:-}"
SOCKET_DIR="${HOME}/.tailscale-gmvmax"
SOCKET_PATH="${SOCKET_DIR}/tailscaled.sock"
TAILSCALE_BIN="${TAILSCALE_BIN:-/opt/homebrew/opt/tailscale/bin/tailscale}"
TAILSCALED_BIN="${TAILSCALED_BIN:-/opt/homebrew/opt/tailscale/bin/tailscaled}"

mkdir -p "$SOCKET_DIR" logs

if ! [ -x "$TAILSCALE_BIN" ] || ! [ -x "$TAILSCALED_BIN" ]; then
  echo "Tailscale not found. Install it with: brew install tailscale"
  exit 1
fi

if [ -z "$TOKEN" ]; then
  echo "Set GMVMAX_MOBILE_TOKEN before running this script."
  echo "Example: GMVMAX_MOBILE_TOKEN=your-token ./start_mobile_funnel.command"
  exit 1
fi

if ! pgrep -f "tailscaled.*${SOCKET_PATH}" >/dev/null 2>&1; then
  echo "Starting Tailscale userspace daemon..."
  /usr/bin/nohup "$TAILSCALED_BIN" \
    --tun=userspace-networking \
    --statedir="$SOCKET_DIR" \
    --socket="$SOCKET_PATH" \
    > logs/tailscaled-mobile.out.log \
    2> logs/tailscaled-mobile.err.log &
  sleep 3
fi

"$TAILSCALE_BIN" --socket="$SOCKET_PATH" up --hostname="$HOSTNAME"

if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Starting LIVE GMV Max mobile server on port ${PORT}..."
  GMVMAX_MOBILE_PORT="$PORT" GMVMAX_MOBILE_TOKEN="$TOKEN" node src/mobile-server.js \
    > logs/mobile-server.out.log \
    2> logs/mobile-server.err.log &
  sleep 2
fi

"$TAILSCALE_BIN" --socket="$SOCKET_PATH" funnel --bg --yes "$PORT"

echo ""
echo "LIVE mobile panel is running:"
"$TAILSCALE_BIN" --socket="$SOCKET_PATH" funnel status
echo ""
echo "Public URL: https://${HOSTNAME}.tail8ecb21.ts.net/?token=${TOKEN}"
