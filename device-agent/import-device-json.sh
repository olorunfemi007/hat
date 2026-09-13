#!/usr/bin/env bash
# Installed as /opt/hardhat/device-agent/import-device-json.sh, run once per
# boot by hardhat-device-import.service, ordered before
# hardhat-heartbeat.service starts. Looks for a device.json an operator
# dropped onto the boot partition while flashing this specific unit's SD
# card (see device-agent/README.md's "Zero-touch provisioning" section)
# and, if present and valid for this physical Pi, installs it as
# /etc/hardhat/device.json with the ownership/permissions
# hardhat-heartbeat.service requires, then removes it from the boot
# partition -- FAT32 has no real Unix permissions, so a file left there is
# readable by anyone with the card in a reader for as long as it sits
# there.
#
# Every path below is overridable via environment variable, for testing --
# production defaults require no configuration at all.
set -euo pipefail

HEARTBEAT_PY="${HARDHAT_HEARTBEAT_PY:-/opt/hardhat/device-agent/heartbeat.py}"
DEST="${HARDHAT_DEVICE_JSON:-/etc/hardhat/device.json}"
OWNER="${HARDHAT_OWNER:-hardhat-heartbeat}"
GROUP="${HARDHAT_GROUP:-$OWNER}"
HARDWARE_SERIAL_FILE="${HARDHAT_HARDWARE_SERIAL_FILE:-/proc/device-tree/serial-number}"
# Space-separated, checked in order -- Raspberry Pi OS Bookworm/Trixie mount
# the boot partition at /boot/firmware; older images used /boot directly.
BOOT_CANDIDATES="${HARDHAT_BOOT_CANDIDATES:-/boot/firmware/device.json /boot/device.json}"

SOURCE=""
for candidate in $BOOT_CANDIDATES; do
  if [ -f "$candidate" ]; then
    SOURCE="$candidate"
    break
  fi
done
if [ -z "$SOURCE" ]; then
  echo "no device.json on the boot partition -- nothing to import"
  exit 0
fi

STAGING="$(mktemp)"
trap 'rm -f "$STAGING"' EXIT
# FAT32 (the boot partition) has no real Unix permission bits -- vfat
# reports a fixed, typically world-readable mode for every file regardless
# of what's "on disk", which would fail heartbeat.py's own private-file
# check even for a file that's about to be installed correctly. Copy to a
# real filesystem with real permissions before validating.
install -m 0600 "$SOURCE" "$STAGING"

reject() {
  echo "refusing to import $SOURCE: $1" >&2
  mv -f "$SOURCE" "$SOURCE.rejected" 2>/dev/null || true
  exit 1
}

if [ -e "$DEST" ]; then
  if cmp -s "$STAGING" "$DEST"; then
    echo "boot-partition device.json matches the identity already installed -- removing the redundant copy"
    rm -f "$SOURCE"
    exit 0
  fi
  reject "$DEST already exists and holds a different identity"
fi

# Reuses heartbeat.py's own validation (schema shape + this-Pi hardware
# pairing) rather than re-implementing any of it here -- exactly the "one
# place this has to be correct" rule the rest of this project follows for
# every other validation path (see e.g. seed.sql's header on
# provision_devices()).
if ! env python3 -B "$HEARTBEAT_PY" --config "$STAGING" \
    --hardware-serial-file "$HARDWARE_SERIAL_FILE" --check-config; then
  reject "failed validation (see the error above)"
fi

install -d -m 0755 "$(dirname "$DEST")"
install -m 0600 -o "$OWNER" -g "$GROUP" "$STAGING" "$DEST"
rm -f "$SOURCE"
echo "imported device identity from the boot partition into $DEST"
