#!/usr/bin/env bash
# Runs ON the VM (Debian 12). Installs the Python tools and runs
# the app + land cover server (tools/serve.py) as a systemd
# service on 127.0.0.1:$PORT. Safe to run again after new code
# is uploaded: it reinstalls requirements and restarts.
#
# Called by deploy/gcp.sh and deploy/aws.sh; not meant to be run
# on your own machine.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8000}"
VENV="$APP_DIR/tools/.venv"

echo "== Installing system packages"
sudo apt-get update -y -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
    python3-venv python3-pip curl

echo "== Installing Python requirements"
if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$APP_DIR/tools/requirements.txt"

mkdir -p "$APP_DIR/tools/data"

echo "== Starting the service (port $PORT, localhost only)"
sudo tee /etc/systemd/system/city-planner.service >/dev/null <<EOF
[Unit]
Description=AI City Planner (app + land cover server)
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$APP_DIR
ExecStart=$VENV/bin/python $APP_DIR/tools/serve.py --port $PORT
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable -q city-planner
sudo systemctl restart city-planner

for _ in $(seq 1 20); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
        echo "== Server is up on the VM (127.0.0.1:$PORT)"
        exit 0
    fi
    sleep 1
done

echo "Server did not answer; see: sudo journalctl -u city-planner -n 50" >&2
exit 1
