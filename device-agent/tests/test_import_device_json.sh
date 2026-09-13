#!/usr/bin/env bash
# Functional test for ../import-device-json.sh -- runs the real script
# against fake boot-partition/etc/hardware-serial-file paths (every path in
# that script is overridable via env var for exactly this reason), not a
# reimplementation of its logic. Uses the real heartbeat.py for validation,
# same as production. No sudo/root required: HARDHAT_OWNER/HARDHAT_GROUP
# are set to the current user, so `install -o/-g` succeeds "chowning to
# yourself".
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../import-device-json.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

FAKE_SERIAL="000000001234abcd"
DEVICE_JSON='{
  "serial_number": "TEST-0001",
  "hardware_serial": "'"$FAKE_SERIAL"'",
  "device_identity_secret": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "supabase_url": "https://example.supabase.co",
  "publishable_key": "sb_publishable_test"
}'
DIFFERENT_DEVICE_JSON='{
  "serial_number": "TEST-0002",
  "hardware_serial": "'"$FAKE_SERIAL"'",
  "device_identity_secret": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "supabase_url": "https://example.supabase.co",
  "publishable_key": "sb_publishable_test"
}'

setup_env() {
  WORK="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  BOOT="$WORK/boot"
  mkdir -p "$BOOT"
  export HARDHAT_BOOT_CANDIDATES="$BOOT/device.json"
  export HARDHAT_DEVICE_JSON="$WORK/etc-hardhat-device.json"
  export HARDHAT_HEARTBEAT_PY="$HERE/../heartbeat.py"
  export HARDHAT_HARDWARE_SERIAL_FILE="$WORK/serial"
  printf '%s\0' "$FAKE_SERIAL" > "$HARDHAT_HARDWARE_SERIAL_FILE"
  export HARDHAT_OWNER
  HARDHAT_OWNER="$(id -un)"
  export HARDHAT_GROUP
  HARDHAT_GROUP="$(id -gn)"
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

echo "=== T1: no file on boot partition ==="
setup_env
if OUT="$(bash "$SCRIPT" 2>&1)" && echo "$OUT" | grep -q "nothing to import" && [ ! -e "$HARDHAT_DEVICE_JSON" ]; then
  pass "T1 no-op when boot partition has no device.json, exits 0"
else
  fail "T1 no-op when boot partition has no device.json, exits 0"; echo "$OUT"
fi

echo "=== T2: valid file, no existing identity ==="
setup_env
echo "$DEVICE_JSON" > "$BOOT/device.json"
if OUT="$(bash "$SCRIPT" 2>&1)" \
    && [ -f "$HARDHAT_DEVICE_JSON" ] \
    && [ ! -e "$BOOT/device.json" ] \
    && [ "$(file_mode "$HARDHAT_DEVICE_JSON")" = "600" ] \
    && cmp -s <(printf '%s\n' "$DEVICE_JSON") "$HARDHAT_DEVICE_JSON"; then
  pass "T2 valid file + no existing identity: imported at 0600, source removed"
else
  fail "T2 valid file + no existing identity: imported at 0600, source removed"; echo "${OUT:-}"
fi

echo "=== T3: existing IDENTICAL identity ==="
setup_env
echo "$DEVICE_JSON" > "$BOOT/device.json"
echo "$DEVICE_JSON" > "$HARDHAT_DEVICE_JSON"
if OUT="$(bash "$SCRIPT" 2>&1)" && [ ! -e "$BOOT/device.json" ] && [ -f "$HARDHAT_DEVICE_JSON" ]; then
  pass "T3 existing identical identity: redundant boot-partition copy silently removed"
else
  fail "T3 existing identical identity: redundant boot-partition copy silently removed"; echo "${OUT:-}"
fi

echo "=== T4: existing DIFFERENT identity ==="
setup_env
echo "$DEVICE_JSON" > "$BOOT/device.json"
echo "$DIFFERENT_DEVICE_JSON" > "$HARDHAT_DEVICE_JSON"
if ! OUT="$(bash "$SCRIPT" 2>&1)"; then
  if [ ! -e "$BOOT/device.json" ] && [ -f "$BOOT/device.json.rejected" ] \
      && cmp -s <(printf '%s\n' "$DIFFERENT_DEVICE_JSON") "$HARDHAT_DEVICE_JSON"; then
    pass "T4 existing different identity: refuses, renames source to .rejected, leaves existing identity untouched"
  else
    fail "T4 existing different identity: refuses, renames source to .rejected, leaves existing identity untouched"; echo "$OUT"
  fi
else
  fail "T4 existing different identity: refuses, renames source to .rejected, leaves existing identity untouched (script exited 0)"
fi

echo "=== T5: file fails validation for THIS Pi (wrong hardware_serial) ==="
setup_env
python3 -c "
import json
d = json.loads('''$DEVICE_JSON''')
d['hardware_serial'] = 'ffffffffffffffff'
open('$BOOT/device.json', 'w').write(json.dumps(d))
"
if ! OUT="$(bash "$SCRIPT" 2>&1)"; then
  if [ ! -e "$BOOT/device.json" ] && [ -f "$BOOT/device.json.rejected" ] && [ ! -e "$HARDHAT_DEVICE_JSON" ]; then
    pass "T5 wrong hardware_serial for this Pi: refuses validation, renames source, nothing installed"
  else
    fail "T5 wrong hardware_serial for this Pi: refuses validation, renames source, nothing installed"; echo "$OUT"
  fi
else
  fail "T5 wrong hardware_serial for this Pi: refuses validation, renames source, nothing installed (script exited 0)"
fi

echo
echo "RESULTS: $PASS passed, $FAIL failed (total $((PASS + FAIL)))"
[ "$FAIL" -eq 0 ]
