#!/usr/bin/env bash
# Install the independent agent; optionally install an operator-issued identity.
# No network configuration is changed. Existing identity files are never replaced.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_SOURCE=""
SYNC_CONFIG_SOURCE=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --config|--sync-config)
            if [ "$#" -lt 2 ]; then echo "Missing configuration path" >&2; exit 1; fi
            if [ "$1" = "--config" ]; then CONFIG_SOURCE="$2"; else SYNC_CONFIG_SOURCE="$2"; fi
            shift 2 ;;
        *) echo "Usage: bash setup_pi.sh [--config /path/to/device.json] [--sync-config /path/to/sync.json]" >&2; exit 1 ;;
    esac
done
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
if [ -n "$SYNC_CONFIG_SOURCE" ]; then
    sudo /usr/bin/python3 -B -c 'import sys; sys.path.insert(0, sys.argv[1]); from sync import load_sync_config; load_sync_config(sys.argv[2])' "$SCRIPT_DIR" "$SYNC_CONFIG_SOURCE"
fi
sudo install -d -m 0755 /opt/hardhat/device-agent /etc/hardhat
sudo install -m 0644 "$SCRIPT_DIR/heartbeat.py" "$SCRIPT_DIR/sync.py" "$SCRIPT_DIR/capture.py" "$SCRIPT_DIR/README.md" "$SCRIPT_DIR/SYNC.md" "$SCRIPT_DIR/sync.example.json" /opt/hardhat/device-agent/
sudo install -d -m 0700 -o hardhat-heartbeat -g hardhat-heartbeat /var/lib/hardhat-sync
# Capture and synchronization share the existing private account/spool. This
# gives the optional voice service access to the already-tested camera/audio
# devices, without running it as root or sharing the identity with login users.
for hardhat_group in video render audio; do
    if getent group "$hardhat_group" >/dev/null; then sudo usermod -a -G "$hardhat_group" hardhat-heartbeat; fi
done
if [ -n "$SYNC_CONFIG_SOURCE" ] && ! sudo cmp -s "$SYNC_CONFIG_SOURCE" /etc/hardhat/sync.json; then
    sudo install -m 0644 "$SYNC_CONFIG_SOURCE" /etc/hardhat/sync.json
fi
sudo install -m 0755 "$SCRIPT_DIR/import-device-json.sh" /opt/hardhat/device-agent/
if [ -n "$CONFIG_SOURCE" ] && ! sudo test -e /etc/hardhat/device.json; then
    sudo install -m 0600 -o hardhat-heartbeat -g hardhat-heartbeat "$CONFIG_SOURCE" /etc/hardhat/device.json
fi
sudo install -m 0644 "$SCRIPT_DIR/hardhat-heartbeat.service" "$SCRIPT_DIR/hardhat-device-import.service" "$SCRIPT_DIR/hardhat-sync.service" /etc/systemd/system/
sudo systemctl daemon-reload
# hardhat-device-import.service is enabled unconditionally, even with no
# --config given now: this is exactly the golden-image-prep case (see
# device-agent/README.md's "Zero-touch provisioning" section) -- baked in
# once here, it then runs on every future boot of every unit cloned from
# this image, importing whatever device.json an operator drops on that
# specific unit's boot partition at flash time.
sudo systemctl enable hardhat-heartbeat.service hardhat-device-import.service hardhat-sync.service
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
    if sudo test -f /etc/hardhat/sync.json; then
        sudo -u hardhat-heartbeat /usr/bin/python3 -B /opt/hardhat/device-agent/sync.py --check-config
        sudo systemctl restart hardhat-sync.service
        echo "Capture sync started. Logs: journalctl -u hardhat-sync.service -f"
    fi
else
    echo "Agent installed. Provision this Pi, then rerun with --config /path/to/device.json."
fi
