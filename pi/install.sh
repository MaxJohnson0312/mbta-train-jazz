#!/usr/bin/env bash
# Install MBTA Train Jazz as a boot service on a Raspberry Pi.
#   curl -sSL .../install.sh | bash      (or just run it from a clone)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/mbta-jazz}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$USER}}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing MBTA Train Jazz"
echo "    source:  $SRC_DIR"
echo "    target:  $APP_DIR"
echo "    user:    $RUN_USER"

# numpy/scipy from apt are prebuilt for the Pi — far faster than pip wheels,
# which may compile from source and take a very long time.
echo "==> Installing system packages"
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip \
                        python3-numpy python3-scipy \
                        libportaudio2 alsa-utils

echo "==> Copying application"
sudo mkdir -p "$APP_DIR"
sudo cp -r "$SRC_DIR/mbtajazz" "$APP_DIR/"
sudo cp "$SRC_DIR/requirements.txt" "$APP_DIR/"

echo "==> Creating virtualenv (with access to apt's numpy/scipy)"
sudo python3 -m venv --system-site-packages "$APP_DIR/venv"
sudo "$APP_DIR/venv/bin/pip" install --upgrade pip
sudo "$APP_DIR/venv/bin/pip" install requests sounddevice
sudo chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

echo "==> Smoke test (rendering 5s offline, no speaker needed)"
"$APP_DIR/venv/bin/python" -m mbtajazz --simulate \
    --render /tmp/mbta-jazz-selftest.wav --seconds 5 2>&1 | tail -2
rm -f /tmp/mbta-jazz-selftest.wav

echo "==> Installing systemd service"
sudo tee /etc/systemd/system/mbta-jazz.service >/dev/null <<EOF
[Unit]
Description=MBTA Train Jazz (headless audio)
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PYTHONUNBUFFERED=1
# Put your key here if you have your own; the built-in one works too.
#Environment=MBTA_API_KEY=xxxxxxxx
ExecStart=$APP_DIR/venv/bin/python -m mbtajazz --volume 0.7
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mbta-jazz.service

cat <<EOF

Done.

  Start now:     sudo systemctl start mbta-jazz
  Watch logs:    journalctl -u mbta-jazz -f
  Stop:          sudo systemctl stop mbta-jazz
  Edit options:  sudo systemctl edit --full mbta-jazz

If you hear nothing, pick the right output first:
  aplay -l                       # list devices
  sudo raspi-config              # System Options > Audio
  alsamixer                      # raise the volume, unmute with M

EOF
