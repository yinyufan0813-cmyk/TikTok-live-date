#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

PORT="${GMVMAX_MOBILE_PORT:-8788}"
URL="http://127.0.0.1:$PORT/"

function port_open() {
  /usr/bin/python3 - "$1" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket()
try:
    sock.settimeout(0.25)
    sock.connect(("127.0.0.1", port))
except OSError:
    raise SystemExit(1)
else:
    raise SystemExit(0)
finally:
    sock.close()
PY
}

function local_ip() {
  /usr/sbin/ipconfig getifaddr en0 2>/dev/null || /usr/sbin/ipconfig getifaddr en1 2>/dev/null || true
}

mkdir -p logs

if ! port_open "$PORT"; then
  /usr/bin/screen -dmS gmvmax-window-mobile zsh -lc "cd '$SCRIPT_DIR' && GMVMAX_MOBILE_PORT='$PORT' npm run mobile >> logs/mobile.out.log 2>> logs/mobile.err.log"
  for _ in {1..20}; do
    if port_open "$PORT"; then
      break
    fi
    /bin/sleep 1
  done
fi

/usr/bin/open "$URL"

PHONE_IP="$(local_ip)"
echo "Mobile dashboard opened: $URL"
if [ -n "$PHONE_IP" ]; then
  echo "Phone URL on the same Wi-Fi: http://$PHONE_IP:$PORT/"
fi
