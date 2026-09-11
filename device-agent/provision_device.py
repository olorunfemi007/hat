#!/usr/bin/env python3
"""Run on an operator workstation, never on a customer Pi."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlencode

from heartbeat import ConfigError, HeartbeatError, jwt_role, rpc, validate_config, validate_public_key, validate_url


def write_private(path, data):
    # Never overwrite a previous identity/label export.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def provision(url, public_key, admin_key, hardware, serial, portal_url, directory, allow_http=False):
    validate_url(url, allow_http)
    validate_url(portal_url, allow_http)
    validate_public_key(public_key)
    if not (admin_key.startswith("sb_secret_") or jwt_role(admin_key) == "service_role"):
        raise ConfigError("operator provisioning requires a secret/service_role API key")
    hardware = hardware.lower()
    # Validate everything before the irreversible one-time secret generation.
    config = validate_config({"serial_number": serial, "hardware_serial": hardware,
        "device_identity_secret": "0" * 40, "supabase_url": url.rstrip("/"),
        "publishable_key": public_key, "allow_http": allow_http})
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    # Reserve a private, durable recovery record BEFORE making the RPC. A network
    # timeout can occur after commit: never automatically retry provisioning.
    write_private(directory / "INCOMPLETE.txt", "Provisioning may have committed. Do not retry blindly.\n")
    rows = rpc(url, admin_key, "provision_devices", {"p_serial_numbers": [serial]}, timeout=30)
    # Preserve the one-time result before any further processing.
    write_private(directory / "provisioning-result.json", json.dumps(rows, indent=2) + "\n")
    if (not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict)
            or rows[0].get("serial_number") != serial
            or not isinstance(rows[0].get("claim_code"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", rows[0]["claim_code"])):
        raise ConfigError("unexpected provisioning result; inspect the private recovery export")
    config["device_identity_secret"] = rows[0].get("device_identity_secret")
    validate_config(config)
    write_private(directory / "device.json", json.dumps(config, indent=2) + "\n")
    claim_url = portal_url.rstrip("/") + "/devices/claim?" + urlencode({
        "serial_number": serial, "claim_code": rows[0]["claim_code"]})
    write_private(directory / "claim-label.txt", "Hard Hat\nSerial: " + serial +
                  "\nClaim code: " + rows[0]["claim_code"] + "\nClaim URL: " + claim_url + "\n")
    (directory / "INCOMPLETE.txt").unlink()
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hardware-serial", required=True, help="Pi serial from /proc/device-tree/serial-number")
    parser.add_argument("--serial", help="optional asset serial; defaults to the hardware serial")
    parser.add_argument("--supabase-url", default=os.getenv("SUPABASE_URL"), required=not os.getenv("SUPABASE_URL"))
    parser.add_argument("--publishable-key", default=os.getenv("SUPABASE_PUBLISHABLE_KEY"), required=not os.getenv("SUPABASE_PUBLISHABLE_KEY"))
    parser.add_argument("--portal-url", required=True)
    parser.add_argument("--output-dir", required=True, help="new private export directory outside the repository")
    parser.add_argument("--allow-http", action="store_true", help="trusted local development only")
    args = parser.parse_args()
    admin_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or getpass.getpass("Operator Supabase secret/service_role key: ")
    try:
        directory = provision(args.supabase_url, args.publishable_key, admin_key,
                              args.hardware_serial, args.serial or args.hardware_serial.lower(),
                              args.portal_url, args.output_dir, args.allow_http)
    except (ConfigError, HeartbeatError, OSError) as exc:
        # OSError can include paths, but never print upstream response bodies or keys.
        print("Provisioning did not complete: " + str(exc), file=sys.stderr)
        print("Inspect the export directory and database before retrying; secrets cannot be regenerated for an existing serial.", file=sys.stderr)
        return 1
    print("Provisioned. Private config and printable claim label saved in " + str(directory))
    print("Install only device.json on the matching Pi; keep the label separate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
