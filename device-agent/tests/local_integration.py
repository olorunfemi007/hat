#!/usr/bin/env python3
"""Real local Supabase lifecycle test; uses isolated records and removes them."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from urllib import parse, request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "device-agent"))
from heartbeat import HeartbeatError, heartbeat, load_config
from provision_device import provision


def main():
    env = {}
    for line in (ROOT / "portal/.env.local").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip("\"'")
    url = env["NEXT_PUBLIC_SUPABASE_URL"]
    if parse.urlsplit(url).hostname not in ("localhost", "127.0.0.1"):
        raise RuntimeError("Integration test is restricted to local Supabase")
    public, admin = env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"], env["SUPABASE_SERVICE_ROLE_KEY"]

    def api(path, body=None, method="POST", token=None):
        key = public if token else admin
        headers = {"apikey": key, "Content-Type": "application/json", "Prefer": "return=representation"}
        if token or key.count(".") == 2:
            headers["Authorization"] = "Bearer " + (token or key)
        req = request.Request(url + path, data=json.dumps(body).encode() if body is not None else None,
                              headers=headers, method=method)
        with request.urlopen(req, timeout=20) as response:
            data = response.read()
            return json.loads(data) if data else None

    serial = "AGENT-TEST-" + secrets.token_hex(8)
    device_path = "/rest/v1/devices?serial_number=eq." + serial
    user_id = org_id = None
    try:
        with tempfile.TemporaryDirectory(prefix="hardhat-agent-test-") as d:
            export = provision(url, public, admin, "000000001234abcd", serial,
                               "http://localhost:3000", Path(d)/"export", allow_http=True)
            fake_serial = Path(d)/"hardware-serial"
            fake_serial.write_bytes(b"000000001234abcd\0")
            cfg = load_config(export/"device.json", fake_serial)
            assert heartbeat(cfg) == "unclaimed"
            print("PASS provision export, hardware binding, and unclaimed heartbeat", flush=True)
            password = secrets.token_hex(24)
            email = "agent-test-" + secrets.token_hex(8) + "@example.test"
            user_id = api("/auth/v1/admin/users", {"email": email, "password": password, "email_confirm": True})["id"]
            token = api("/auth/v1/token?grant_type=password", {"email": email, "password": password})["access_token"]
            org_id = api("/rest/v1/rpc/create_organization", {"p_name": "Device agent integration"}, token=token)["id"]
            label = json.loads((export/"provisioning-result.json").read_text())[0]
            claim = api("/rest/v1/rpc/claim_device", {"p_serial_number": serial, "p_claim_code": label["claim_code"]}, token=token)
            assert claim[0]["status"] == "claimed"
            assert heartbeat(cfg) == "active"
            print("PASS claim then authenticated device heartbeat becomes active", flush=True)
            for override in [{"device_identity_secret": "f"*40}, {"serial_number": serial+"-unknown"}]:
                try:
                    heartbeat(dict(cfg, **override))
                except HeartbeatError as exc:
                    assert exc.rejected
                else:
                    raise AssertionError("Invalid credentials accepted")
            print("PASS invalid secret and unknown serial rejected", flush=True)
            cli = [sys.executable, str(ROOT/"device-agent/heartbeat.py"), "--config", str(export/"device.json"),
                   "--hardware-serial-file", str(fake_serial), "--once"]
            first = api(device_path+"&select=last_seen_at", method="GET")[0]["last_seen_at"]
            result = subprocess.run(cli, capture_output=True, text=True, timeout=20)
            assert result.returncode == 0 and "status=active" in result.stderr
            assert api(device_path+"&select=last_seen_at", method="GET")[0]["last_seen_at"] != first
            print("PASS restarted CLI reloads persistent identity and refreshes last_seen_at", flush=True)
            api(device_path, {"last_seen_at": "2000-01-01T00:00:00Z"}, method="PATCH")
            deadline = time.monotonic() + 80
            while time.monotonic() < deadline:
                if api(device_path+"&select=status", method="GET")[0]["status"] == "offline":
                    break
                print("Waiting for the actual minute-based database scheduler...", flush=True)
                time.sleep(15)
            else:
                raise AssertionError("Scheduled offline sweep did not execute")
            print("PASS actual pg_cron schedule marks stale device offline", flush=True)
            assert heartbeat(cfg) == "active"
            print("PASS connectivity return reactivates offline device", flush=True)
    finally:
        api(device_path, method="DELETE")
        # These identifiers belong only to records created by this test.
        if org_id:
            api("/rest/v1/organizations?id=eq." + org_id, method="DELETE")
        if user_id:
            api("/auth/v1/admin/users/" + user_id, method="DELETE")
        print("Removed isolated integration-test device and account", flush=True)


if __name__ == "__main__":
    main()
