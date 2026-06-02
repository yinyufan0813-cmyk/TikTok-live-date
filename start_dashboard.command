#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

PORT="${GMVMAX_DASHBOARD_PORT:-8789}"
DASHBOARD_URL="http://127.0.0.1:$PORT/dashboard.html"
MOBILE_PORT="${GMVMAX_MOBILE_PORT:-8788}"
CDP_PORT="${GMVMAX_CDP_PORT:-9222}"
CDP_VERSION_URL="http://127.0.0.1:$CDP_PORT/json/version"
CHROME_PROFILE="${GMVMAX_CHROME_PROFILE:-$HOME/.gmvmax-chrome-mac}"
SELLER_URL="${LIVE_ANALYTICS_URL:-https://seller-my.tiktok.com/compass/data-overview?shop_region=MY}"
GMVMAX_URL="${GMVMAX_URL:-}"

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

function process_running() {
  local pattern="$1"
  /bin/ps -axo command | /usr/bin/grep -F "$pattern" | /usr/bin/grep -v grep >/dev/null 2>&1
}

function cdp_open() {
  /usr/bin/curl -fsS "$CDP_VERSION_URL" >/dev/null 2>&1
}

function latest_gmvmax_url() {
  /usr/bin/python3 - "$SCRIPT_DIR" <<'PY'
import csv
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
config_path = root / "config.json"
try:
    config = json.loads(config_path.read_text())
    url = config.get("url") or ""
    if "ads.tiktok.com" in url and "gmv-max/dashboard" in url:
        print(url)
        raise SystemExit(0)
except FileNotFoundError:
    pass
except Exception:
    pass

csv_path = root / "logs" / "gmvmax-plan-records.csv"
try:
    rows = list(csv.reader(csv_path.open()))
except FileNotFoundError:
    rows = []

for row in reversed(rows):
    for value in row:
        if "ads.tiktok.com" in value and "gmv-max/dashboard" in value:
            print(value)
            raise SystemExit(0)

print("https://ads.tiktok.com/i18n/gmv-max/dashboard?activated_tab_id=2&type=live&live_campaign_page=1&live_campaign_page_size=10")
PY
}

function cdp_open_url() {
  local target_url="$1"
  if [ -z "$target_url" ]; then
    return 0
  fi
  /usr/bin/python3 - "$CDP_VERSION_URL" "$target_url" <<'PY'
import json
import sys
import urllib.parse
import urllib.request

version_url, target_url = sys.argv[1], sys.argv[2]
base = version_url.rsplit("/json/version", 1)[0]
try:
    with urllib.request.urlopen(f"{base}/json/list", timeout=2) as response:
        pages = json.load(response)
except Exception:
    pages = []

for page in pages:
    if page.get("url", "").split("#", 1)[0] == target_url.split("#", 1)[0]:
        raise SystemExit(0)

request = urllib.request.Request(f"{base}/json/new?{urllib.parse.quote(target_url, safe='')}", method="PUT")
try:
    urllib.request.urlopen(request, timeout=3).read()
except Exception:
    pass
PY
}

mkdir -p logs

if [ -z "$GMVMAX_URL" ]; then
  GMVMAX_URL="$(latest_gmvmax_url)"
fi

if ! cdp_open; then
  mkdir -p "$CHROME_PROFILE"
  /usr/bin/open -na "Google Chrome" --args \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$CHROME_PROFILE" \
    --no-first-run \
    --no-default-browser-check \
    "$SELLER_URL"

  for _ in {1..30}; do
    if cdp_open; then
      break
    fi
    /bin/sleep 1
  done
fi

if cdp_open; then
  cdp_open_url "$SELLER_URL"
  cdp_open_url "$GMVMAX_URL"
fi

if ! port_open "$PORT"; then
  /usr/bin/screen -dmS gmvmax-window-dashboard zsh -lc "cd '$SCRIPT_DIR' && GMVMAX_DASHBOARD_PORT='$PORT' node src/dashboard-server.js >> logs/dashboard.out.log 2>> logs/dashboard.err.log"
fi

if ! process_running "node src/monitor.js"; then
  /usr/bin/screen -dmS gmvmax-window-monitor zsh -lc "cd '$SCRIPT_DIR' && GMVMAX_URL='$GMVMAX_URL' npm start >> logs/monitor.out.log 2>> logs/monitor.err.log"
fi

if ! process_running "node src/live-monitor.js"; then
  /usr/bin/screen -dmS gmvmax-window-live zsh -lc "cd '$SCRIPT_DIR' && npm run live >> logs/live-monitor.out.log 2>> logs/live-monitor.err.log"
fi

if ! port_open "$MOBILE_PORT"; then
  /usr/bin/screen -dmS gmvmax-window-mobile zsh -lc "cd '$SCRIPT_DIR' && GMVMAX_MOBILE_PORT='$MOBILE_PORT' GMVMAX_MOBILE_TOKEN='${GMVMAX_MOBILE_TOKEN:-}' npm run mobile >> logs/mobile.out.log 2>> logs/mobile.err.log"
fi

/usr/bin/open -na "Google Chrome" --args \
  --app="$DASHBOARD_URL" \
  --window-size=1360,780 \
  --window-position=60,80

echo "GMV Max combined dashboard opened: $DASHBOARD_URL"
echo "Mobile dashboard local URL: http://127.0.0.1:$MOBILE_PORT/"
