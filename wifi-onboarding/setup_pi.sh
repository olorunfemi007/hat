#!/usr/bin/env bash
# One-shot setup for wifi-onboarding on Raspberry Pi OS (Trixie/Debian 13,
# NetworkManager-managed, headless). Installs apt deps, builds the Go
# binary, installs it + the systemd unit, and writes the static config the
# hotspot needs. Safe to re-run - each step skips itself if already done.
#
# Does NOT start or enable the service by itself (see the final printed
# instructions) - if you're SSH'd in over the Pi's own Wi-Fi client
# connection rather than Ethernet, starting this service can switch wlan0
# into AP mode and drop your SSH session if it decides connectivity looks
# bad. Start it deliberately, ideally from a console or Ethernet session
# the first time.
#
# Usage: ./setup_pi.sh

set -euo pipefail

GO_VERSION="1.27.1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/hardhat/wifi-onboarding"
BIN_PATH="/usr/local/bin/wifi-onboarding"
ENV_DIR="/etc/hardhat"
ENV_FILE="$ENV_DIR/wifi-onboarding.env"
UNIT_PATH="/etc/systemd/system/wifi-onboarding.service"
DNSMASQ_DROPIN_DIR="/etc/NetworkManager/dnsmasq-shared.d"
DNSMASQ_DROPIN="$DNSMASQ_DROPIN_DIR/captive.conf"

echo "==> [1/7] Sanity-checking the network stack"
if ! command -v nmcli >/dev/null 2>&1; then
    echo "ERROR: nmcli not found. This project assumes NetworkManager is managing" >&2
    echo "wlan0 (the default on Raspberry Pi OS Bookworm and later). Aborting." >&2
    exit 1
fi
echo "nmcli found: $(nmcli --version)"

echo
echo "==> [2/7] apt packages"
sudo apt-get update
# dnsmasq-base (NOT plain dnsmasq): NetworkManager's shared-mode AP execs the
# dnsmasq binary itself as a private per-connection instance. The full
# dnsmasq package also installs a system-wide dnsmasq.service, which would
# grab UDP/TCP port 53 first and make the hotspot's DNS silently fail to bind.
sudo apt-get install -y build-essential dnsmasq-base nftables

if systemctl is-enabled dnsmasq.service >/dev/null 2>&1 || systemctl is-active dnsmasq.service >/dev/null 2>&1; then
    echo "WARNING: a system-wide dnsmasq.service is enabled/active - disabling it now."
    echo "(it will otherwise block NetworkManager's own hotspot DNS from binding port 53)"
    sudo systemctl disable --now dnsmasq.service
fi

echo
echo "==> [3/7] Go toolchain"
if command -v go >/dev/null 2>&1; then
    echo "go already installed: $(go version)"
    GO_BIN="$(command -v go)"
else
    case "$(uname -m)" in
        aarch64) GO_ARCH="arm64" ;;
        armv7l|armv6l) GO_ARCH="armv6l" ;;
        x86_64) GO_ARCH="amd64" ;;
        *) echo "unrecognized architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    TARBALL="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
    echo "downloading $TARBALL ..."
    curl -LO "https://go.dev/dl/${TARBALL}"
    sudo tar -C /usr/local -xzf "$TARBALL"
    rm -f "$TARBALL"
    if ! grep -q '/usr/local/go/bin' "$HOME/.bashrc" 2>/dev/null; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> "$HOME/.bashrc"
    fi
    export PATH="$PATH:/usr/local/go/bin"
    GO_BIN="/usr/local/go/bin/go"
    echo "installed: $("$GO_BIN" version)"
fi

echo
echo "==> [4/7] Building wifi-onboarding"
(cd "$SCRIPT_DIR" && "$GO_BIN" build -o wifi-onboarding .)
sudo install -m 0755 "$SCRIPT_DIR/wifi-onboarding" "$BIN_PATH"
echo "installed to $BIN_PATH"

echo
echo "==> [5/7] Copying source + docs for reference (systemd unit's Documentation= points here)"
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r "$SCRIPT_DIR"/*.go "$SCRIPT_DIR"/*.html "$SCRIPT_DIR"/go.mod "$SCRIPT_DIR"/README.md "$INSTALL_DIR/" 2>/dev/null || true

echo
echo "==> [6/7] Static config: AP password file + captive-portal DNS redirect"
sudo mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
    cat <<'EOF' | sudo tee "$ENV_FILE" >/dev/null
# Passphrase for the temporary "Hardhat-Setup" onboarding hotspot.
# Must be 8-63 characters (WPA2 requirement). CHANGE THIS before deploying -
# anyone in range who knows it can join the setup hotspot while it's up.
AP_PASSWORD=hardhat-setup
EOF
    echo "wrote default $ENV_FILE - edit AP_PASSWORD before relying on this"
else
    echo "$ENV_FILE already exists, leaving its content alone"
fi
sudo chmod 600 "$ENV_FILE"

sudo mkdir -p "$DNSMASQ_DROPIN_DIR"
if [ ! -f "$DNSMASQ_DROPIN" ] || ! grep -q '^address=/#/' "$DNSMASQ_DROPIN" 2>/dev/null; then
    # Wildcard-domain dnsmasq syntax: '#' matches any domain. Makes every DNS
    # query from a client on the hotspot resolve to the Pi itself, which is
    # what routes OS captive-portal probes (real hostnames like
    # captive.apple.com) to our HTTP server instead of failing to resolve.
    printf 'address=/#/%s\n' "192.168.4.1" | sudo tee "$DNSMASQ_DROPIN" >/dev/null
    echo "wrote $DNSMASQ_DROPIN"
else
    echo "$DNSMASQ_DROPIN already present, leaving it alone"
fi
echo "NOTE: if you override -ap-address away from the 192.168.4.0/24 default," \
     "update the address in $DNSMASQ_DROPIN to match the new gateway IP."

echo
echo "==> [7/7] Installing systemd unit (not starting it yet)"
sudo install -m 0644 "$SCRIPT_DIR/wifi-onboarding.service" "$UNIT_PATH"
sudo systemctl daemon-reload
sudo systemctl enable wifi-onboarding.service
echo "unit installed and enabled for boot - not started"

echo
echo "==> Setup complete."
echo
echo "Before starting the service:"
echo "  - review/edit $ENV_FILE (set a real AP_PASSWORD)"
echo "  - if possible, do the first start over Ethernet or a local console,"
echo "    not over the Pi's own Wi-Fi - see the warning at the top of this script"
echo
echo "Start it with:"
echo "  sudo systemctl start wifi-onboarding.service"
echo "  journalctl -u wifi-onboarding.service -f"
