#!/usr/bin/env bash
# Install the camera-to-cloud voice service after the existing Pi agent setup.
# This is separate from the working bench/hardware setup and does not touch Wi-Fi.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALSA_DEVICE="plughw:0,0"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --alsa-device)
            if [ "$#" -lt 2 ]; then echo "Missing ALSA device" >&2; exit 1; fi
            ALSA_DEVICE="$2"; shift 2 ;;
        *) echo "Usage: bash setup_capture_service.sh [--alsa-device plughw:CARD,DEVICE]" >&2; exit 1 ;;
    esac
done
if [[ ! "$ALSA_DEVICE" =~ ^[A-Za-z0-9_:,.=-]+$ ]]; then
    echo "Invalid ALSA device name" >&2; exit 1
fi
if ! id -u hardhat-heartbeat >/dev/null 2>&1 || [ ! -f /opt/hardhat/device-agent/capture.py ]; then
    echo "Run device-agent/setup_pi.sh first." >&2; exit 1
fi
if [ ! -f /etc/hardhat/sync.json ]; then
    echo "Install /etc/hardhat/sync.json with the portal URL first (device-agent/SYNC.md)." >&2; exit 1
fi
if ! command -v rpicam-vid >/dev/null && ! command -v libcamera-vid >/dev/null; then
    echo "Install/test the Raspberry Pi camera tools first." >&2; exit 1
fi
export PATH="$PATH:/usr/local/go/bin"
if ! command -v go >/dev/null; then echo "Run voice-trigger/setup_pi.sh first to install Go." >&2; exit 1; fi
sudo apt-get update
sudo apt-get install -y python3-venv alsa-utils ffmpeg
(cd "$SCRIPT_DIR" && go build -o voice-trigger .)
sudo install -d -m 0755 /opt/hardhat/voice-trigger
sudo install -m 0755 "$SCRIPT_DIR/voice-trigger" /opt/hardhat/voice-trigger/
sudo install -m 0644 "$SCRIPT_DIR/kws_listen.py" "$SCRIPT_DIR/keyword.list" "$SCRIPT_DIR/README.md" /opt/hardhat/voice-trigger/
# /opt avoids a private login home blocking the service account's microphone
# listener. It also survives changing/deleting the original operator account.
if [ ! -x /opt/hardhat/voice-trigger/venv/bin/python3 ]; then
    sudo /usr/bin/python3 -m venv /opt/hardhat/voice-trigger/venv
fi
sudo /opt/hardhat/voice-trigger/venv/bin/pip install 'pocketsphinx==5.1.1'
sudo -u hardhat-heartbeat /opt/hardhat/voice-trigger/venv/bin/python3 -c '
from pocketsphinx import get_model_path
from pathlib import Path
p = Path(get_model_path()) / "en-us"
assert (p / "en-us").is_dir() and (p / "cmudict-en-us.dict").is_file(), "Bundled models missing: install matched models and override the listener command before enabling voice capture"
'
for hardhat_group in video render audio; do
    if getent group "$hardhat_group" >/dev/null; then sudo usermod -a -G "$hardhat_group" hardhat-heartbeat; fi
done
# Preserve subsequent operator edits (microphone/model/custom camera commands).
if ! sudo test -e /etc/hardhat/voice-trigger.env; then
    sudo tee /etc/hardhat/voice-trigger.env >/dev/null <<EOF
HARDHAT_LISTEN_CMD="/opt/hardhat/voice-trigger/venv/bin/python3 /opt/hardhat/voice-trigger/kws_listen.py --alsa_device $ALSA_DEVICE"
HARDHAT_CAMERA_CMD="/usr/bin/python3 -B /opt/hardhat/device-agent/capture.py"
HARDHAT_LIGHT_ON_CMD=""
HARDHAT_LIGHT_OFF_CMD=""
EOF
    sudo chmod 0644 /etc/hardhat/voice-trigger.env
fi
sudo install -m 0644 "$SCRIPT_DIR/hardhat-voice.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hardhat-voice.service hardhat-sync.service
echo "Voice capture and sync enabled. Stop any old foreground/tmux voice listener to avoid microphone contention."
echo "Logs: journalctl -u hardhat-voice.service -u hardhat-sync.service -f"
