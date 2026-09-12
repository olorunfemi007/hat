#!/usr/bin/env bash
# Install the independent agent; optionally install an operator-issued identity.
# No network configuration is changed. Existing identity files are never replaced.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_SOURCE=""
if [ "$#" -gt 0 ]; then
    if [ "$#" -ne 2 ] || [ "$1" != "--config" ]; then
        echo "Usage: bash setup_pi.sh [--config /path/to/device.json]" >&2
        exit 1
    fi
    CONFIG_SOURCE="$2"
fi
if [ ! -r /proc/device-tree/serial-number ] || ! command -v systemctl >/dev/null; then
    echo "Run this installer on the Raspberry Pi with systemd." >&2
    exit 1
fi
if [ ! -x /usr/bin/python3 ]; then
    sudo apt-get update
    sudo apt-get install -y python3
fi
sudo apt-get install -y ca-certificates
# Fixed system account the service runs as and that owns
# /etc/hardhat/device.json directly (see hardhat-heartbeat.service's header
# comment for why this replaced DynamicUser=yes+LoadCredential=). Created
# unconditionally, before anything below references it; harmless if it
# already exists from a prior run.
if ! getent group hardhat-heartbeat >/dev/null; then
    sudo groupadd --system hardhat-heartbeat
fi
if ! id -u hardhat-heartbeat >/dev/null 2>&1; then
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin \
        --gid hardhat-heartbeat hardhat-heartbeat
fi
if [ -n "$CONFIG_SOURCE" ]; then
    sudo /usr/bin/python3 -B "$SCRIPT_DIR/heartbeat.py" --config "$CONFIG_SOURCE" --check-config
    if sudo test -e /etc/hardhat/device.json && ! sudo cmp -s "$CONFIG_SOURCE" /etc/hardhat/device.json; then
        echo "Existing Pi identity differs; refusing to overwrite it." >&2
        exit 1
    fi
fi
sudo install -d -m 0755 /opt/hardhat/device-agent /etc/hardhat
sudo install -m 0644 "$SCRIPT_DIR/heartbeat.py" "$SCRIPT_DIR/README.md" /opt/hardhat/device-agent/
if [ -n "$CONFIG_SOURCE" ] && ! sudo test -e /etc/hardhat/device.json; then
    sudo install -m 0600 -o hardhat-heartbeat -g hardhat-heartbeat "$CONFIG_SOURCE" /etc/hardhat/device.json
fi
sudo install -m 0644 "$SCRIPT_DIR/hardhat-heartbeat.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hardhat-heartbeat.service
if sudo test -f /etc/hardhat/device.json; then
    # Always re-assert this, regardless of whether the file was just
    # installed by this script or was already present from an earlier
    # run/manual transfer: install -m 0600 above only ever runs on the
    # "didn't already exist" branch, so a pre-existing file (matched by
    # content, never touched) can carry whatever permissions its transfer
    # method left it with. Idempotent and harmless on the already-correct
    # case.
    sudo chmod 600 /etc/hardhat/device.json
    sudo chown hardhat-heartbeat:hardhat-heartbeat /etc/hardhat/device.json
    # Runs as hardhat-heartbeat, not root: proves the exact access path the
    # service itself will use actually works, so a permission problem is
    # caught here -- loudly, at install time -- instead of only surfacing
    # later as a silent, hard-to-diagnose service start failure.
    sudo -u hardhat-heartbeat /usr/bin/python3 -B /opt/hardhat/device-agent/heartbeat.py --check-config
    sudo systemctl restart hardhat-heartbeat.service
    echo "Heartbeat service started. Logs: journalctl -u hardhat-heartbeat.service -f"
else
    echo "Agent installed. Provision this Pi, then rerun with --config /path/to/device.json."
fi
