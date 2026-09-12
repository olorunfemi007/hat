#!/usr/bin/env python3
"""Persistent Pi identity and outbound heartbeats; Python standard library only."""
import argparse
import base64
import json
import logging
import os
from pathlib import Path
import random
import re
import signal
import stat
import threading
from urllib import error, parse, request

LOG = logging.getLogger("hardhat-heartbeat")
MAX_RESPONSE = 65536
HARDWARE_SERIAL_FILE = "/proc/device-tree/serial-number"


class ConfigError(ValueError):
    pass


class HeartbeatError(Exception):
    def __init__(self, message, rejected=False):
        super().__init__(message)
        self.rejected = rejected


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a device secret to another URL, including captive portals.
        return None


def validate_url(value, allow_http=False):
    if not isinstance(value, str):
        raise ConfigError("supabase_url must be a URL")
    try:
        url = parse.urlsplit(value)
        _ = url.port
    except ValueError:
        raise ConfigError("invalid Supabase URL") from None
    if (url.scheme not in (["https", "http"] if allow_http else ["https"])
            or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ("", "/")
            or any(c.isspace() for c in value)):
        raise ConfigError("use a bare HTTPS Supabase URL (HTTP requires explicit development opt-in)")
    return value.rstrip("/")


def jwt_role(key):
    try:
        payload = key.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("role")
    except (IndexError, ValueError, TypeError, AttributeError):
        return None


def validate_public_key(key):
    if not isinstance(key, str) or not key or any(c.isspace() for c in key):
        raise ConfigError("a publishable or legacy anon API key is required")
    if key.startswith("sb_publishable_") or jwt_role(key) == "anon":
        return key
    raise ConfigError("devices must use a publishable/anon key, never an administrative key")


def hardware_serial(path=HARDWARE_SERIAL_FILE):
    try:
        serial = Path(path).read_text(encoding="ascii").strip("\x00\r\n ").lower()
    except (OSError, UnicodeError):
        raise ConfigError("cannot read the Pi hardware serial") from None
    if not re.fullmatch(r"[0-9a-f]{16}", serial):
        raise ConfigError("Pi hardware serial must be 16 hexadecimal characters")
    return serial


def validate_config(config):
    if not isinstance(config, dict):
        raise ConfigError("device configuration must be an object")
    required = {"serial_number", "hardware_serial", "device_identity_secret", "supabase_url", "publishable_key"}
    if not required <= config.keys() or config.keys() - required - {"allow_http"}:
        raise ConfigError("configuration has missing or unknown fields")
    if type(config.get("allow_http", False)) is not bool:
        raise ConfigError("allow_http must be a boolean")
    serial = config["serial_number"]
    if not isinstance(serial, str) or not serial.strip() or len(serial) > 255 or any(ord(c) < 32 for c in serial):
        raise ConfigError("invalid serial_number")
    if not isinstance(config["hardware_serial"], str) or not re.fullmatch(r"[0-9a-f]{16}", config["hardware_serial"]):
        raise ConfigError("hardware_serial must be 16 lowercase hexadecimal characters")
    if not isinstance(config["device_identity_secret"], str) or not re.fullmatch(r"[0-9a-f]{40}", config["device_identity_secret"]):
        raise ConfigError("device_identity_secret must be the 40-character provisioning secret")
    validate_url(config["supabase_url"], config.get("allow_http", False))
    validate_public_key(config["publishable_key"])
    return config


def load_config(path, serial_path=HARDWARE_SERIAL_FILE):
    try:
        with open(path, encoding="utf-8") as source:
            mode = os.fstat(source.fileno()).st_mode
            if not stat.S_ISREG(mode) or stat.S_IMODE(mode) & 0o077:
                raise ConfigError("device configuration must be a private file (mode 0600 or 0400)")
            config = validate_config(json.load(source))
    except (OSError, json.JSONDecodeError, UnicodeError):
        raise ConfigError("cannot read device configuration") from None
    if config["hardware_serial"] != hardware_serial(serial_path):
        raise ConfigError("device configuration belongs to a different Pi")
    return config


def rpc(url, key, function, payload, timeout=10):
    headers = {"apikey": key, "Content-Type": "application/json", "Accept": "application/json"}
    # New opaque keys belong only in apikey. Legacy JWT keys also serve as bearer tokens.
    if key.count(".") == 2:
        headers["Authorization"] = "Bearer " + key
    req = request.Request(url.rstrip("/") + "/rest/v1/rpc/" + function,
                          data=json.dumps(payload).encode(), headers=headers, method="POST")
    opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise HeartbeatError("response exceeds size limit")
            return json.loads(data)
    except error.HTTPError as exc:
        code = exc.code
        exc.close()
        raise HeartbeatError("server returned HTTP " + str(code), rejected=code in (400, 401, 403, 429)) from None
    except (error.URLError, TimeoutError, OSError):
        raise HeartbeatError("server unreachable or request timed out") from None
    except (ValueError, UnicodeError):
        raise HeartbeatError("server returned invalid JSON") from None


def heartbeat(config, timeout=10):
    rows = rpc(config["supabase_url"], config["publishable_key"], "device_heartbeat", {
        "p_serial_number": config["serial_number"],
        "p_device_identity_secret": config["device_identity_secret"],
        "p_hardware_serial": config["hardware_serial"],
    }, timeout)
    if rows == []:
        # SQL intentionally returns HTTP 200 + [] for rejected/throttled credentials.
        raise HeartbeatError("identity rejected or throttled; check provisioning", rejected=True)
    if (not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict)
            or rows[0].get("serial_number") != config["serial_number"]
            or rows[0].get("status") not in ("unclaimed", "active")
            or not isinstance(rows[0].get("last_seen_at"), str) or not rows[0]["last_seen_at"]):
        raise HeartbeatError("server returned an unexpected heartbeat result")
    return rows[0]["status"]


def run(config, stop, send=heartbeat, jitter=random.uniform):
    failures = 0
    previous = None
    while not stop.is_set():
        try:
            status = send(config)
            if previous != status or failures:
                LOG.info("heartbeat accepted; status=%s", status)
            previous, failures = status, 0
            delay = 60 + jitter(0, 5)
        except HeartbeatError as exc:
            failures += 1
            # Exceed the DB's 15-minute throttle window on credential rejection.
            delay = (960 if exc.rejected else min(60, 5 * 2 ** min(failures - 1, 4))) + jitter(0, 5)
            LOG.warning("%s; retry in %.0fs", exc, delay)
        stop.wait(delay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/hardhat/device.json")
    parser.add_argument("--hardware-serial-file", default=HARDWARE_SERIAL_FILE)
    parser.add_argument("--check-config", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        config = load_config(args.config, args.hardware_serial_file)
    except ConfigError as exc:
        LOG.error("%s", exc)
        return 78
    if args.check_config:
        LOG.info("device identity matches this Pi")
        return 0
    if args.once:
        try:
            LOG.info("heartbeat accepted; status=%s", heartbeat(config))
            return 0
        except HeartbeatError as exc:
            LOG.error("%s", exc)
            return 1
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    run(config, stop)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
