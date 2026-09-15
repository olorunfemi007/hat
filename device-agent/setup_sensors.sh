#!/usr/bin/env bash
# Install the continuous-sensor sampling/sync service after the existing Pi
# agent setup (device-agent/setup_pi.sh). Separate from it, same pattern as
# voice-trigger/setup_capture_service.sh: its own dedicated venv (sensor
# drivers can have real pip dependencies; device-agent's core stays
# standard-library-only), installed alongside sync.py/capture.py so
# sensors.py can import sync.Queue directly.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_SOURCE=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --config)
            if [ "$#" -lt 2 ]; then echo "Missing sensors config path" >&2; exit 1; fi
            CONFIG_SOURCE="$2"; shift 2 ;;
        *) echo "Usage: bash setup_sensors.sh [--config /path/to/sensors.json]" >&2; exit 1 ;;
    esac
done
if ! id -u hardhat-heartbeat >/dev/null 2>&1 || [ ! -f /opt/hardhat/device-agent/sync.py ]; then
    echo "Run device-agent/setup_pi.sh first." >&2; exit 1
fi
if [ ! -f /etc/hardhat/sync.json ]; then
    echo "Install /etc/hardhat/sync.json with the portal URL first (device-agent/SYNC.md)." >&2; exit 1
fi
sudo apt-get update
sudo apt-get install -y python3-venv
sudo install -d -m 0755 /opt/hardhat/device-agent/sensor_drivers
sudo install -m 0644 "$SCRIPT_DIR/sensors.py" "$SCRIPT_DIR/sensors.example.json" /opt/hardhat/device-agent/
sudo install -m 0644 "$SCRIPT_DIR/sensor_drivers/__init__.py" "$SCRIPT_DIR/sensor_drivers/dht11.py" /opt/hardhat/device-agent/sensor_drivers/
# /opt avoids a private login home blocking the service account's device
# access, same reasoning as voice-trigger's venv (setup_capture_service.sh).
if [ ! -x /opt/hardhat/sensors-venv/bin/python3 ]; then
    sudo /usr/bin/python3 -m venv /opt/hardhat/sensors-venv
fi
sudo /opt/hardhat/sensors-venv/bin/pip install 'adafruit-circuitpython-dht' 'adafruit-blinka'
# GPIO device nodes, not an audio/video one: separate group from setup_pi.sh's
# video/render/audio (camera/mic), added only when this service is actually installed.
for hardhat_group in gpio i2c spi; do
    if getent group "$hardhat_group" >/dev/null; then sudo usermod -a -G "$hardhat_group" hardhat-heartbeat; fi
done
if [ -n "$CONFIG_SOURCE" ]; then
    sudo /opt/hardhat/sensors-venv/bin/python3 -B -c 'import sys; sys.path.insert(0, sys.argv[1]); from sensors import load_sensors_config; load_sensors_config(sys.argv[2])' /opt/hardhat/device-agent "$CONFIG_SOURCE"
    if ! sudo test -e /etc/hardhat/sensors.json || ! sudo cmp -s "$CONFIG_SOURCE" /etc/hardhat/sensors.json; then
        sudo install -m 0644 "$CONFIG_SOURCE" /etc/hardhat/sensors.json
    fi
fi
sudo install -m 0644 "$SCRIPT_DIR/hardhat-sensors.service" /etc/systemd/system/
sudo systemctl daemon-reload
if sudo test -f /etc/hardhat/sensors.json; then
    sudo systemctl enable --now hardhat-sensors.service
    echo "Sensor sampling started. Logs: journalctl -u hardhat-sensors.service -f"
else
    echo "Service installed but not started: copy a sensors.json to /etc/hardhat/sensors.json (see sensors.example.json), then rerun with --config or run: sudo systemctl enable --now hardhat-sensors.service"
fi
