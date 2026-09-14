#!/usr/bin/env python3
"""Durable capture queue and direct-to-storage uploader (Python standard library)."""
import argparse
import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import http.client
import json
import logging
import os
from pathlib import Path
import random
import shutil
import signal
import sqlite3
import ssl
import stat
import threading
import time
from urllib.parse import urlsplit
import uuid

from heartbeat import ConfigError, HARDWARE_SERIAL_FILE, load_config, validate_url

LOG = logging.getLogger("hardhat-sync")
MAX_CAPTURE_BYTES = 64 * 1024 * 1024
MAX_RESPONSE = 64 * 1024
DEFAULT_SPOOL = "/var/lib/hardhat-sync"


class SyncError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class QueueFull(SyncError):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(256 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sync_directory(path):
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value):
    temp = path.with_name(path.name + ".tmp")
    with open(temp, "x", encoding="utf-8") as stream:
        os.chmod(temp, 0o600)
        json.dump(value, stream, separators=(",", ":"), allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    sync_directory(path.parent)


def load_sync_config(path):
    try:
        with open(path, encoding="utf-8") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ConfigError("sync configuration must be a regular file")
            config = json.load(stream)
    except (OSError, ValueError, UnicodeError):
        raise ConfigError("cannot read sync configuration") from None
    if not isinstance(config, dict) or config.keys() - {
        "portal_url", "allow_http", "spool_dir", "max_spool_bytes", "min_free_bytes",
        "retention_hours", "poll_seconds", "timeout_seconds",
    }:
        raise ConfigError("invalid sync configuration fields")
    if type(config.get("allow_http", False)) is not bool:
        raise ConfigError("allow_http must be a boolean")
    try:
        config["portal_url"] = validate_url(config.get("portal_url"), config.get("allow_http", False))
    except ConfigError:
        raise ConfigError("portal_url must be a bare HTTPS origin; HTTP requires allow_http for development") from None
    defaults = {"max_spool_bytes": 2 * 1024**3, "min_free_bytes": 256 * 1024**2,
                "retention_hours": 24, "poll_seconds": 15, "timeout_seconds": 60}
    for key, default in defaults.items():
        value = config.setdefault(key, default)
        if type(value) is not int or value < (0 if key in ("retention_hours", "min_free_bytes") else 1):
            raise ConfigError(key + " must be a nonnegative integer within its allowed range")
    if config["max_spool_bytes"] < MAX_CAPTURE_BYTES or config["poll_seconds"] > 3600 or config["timeout_seconds"] > 300:
        raise ConfigError("spool must hold at least 64 MiB; poll <= 3600s and timeout <= 300s")
    spool = config.setdefault("spool_dir", DEFAULT_SPOOL)
    if not isinstance(spool, str) or not Path(spool).is_absolute():
        raise ConfigError("spool_dir must be an absolute path")
    return config


def validate_capture(value):
    if not isinstance(value, dict):
        raise SyncError("invalid capture manifest")
    try:
        if str(uuid.UUID(value["capture_id"])) != value["capture_id"]:
            raise ValueError()
        captured = datetime.fromisoformat(value["captured_at"].replace("Z", "+00:00"))
        if captured.tzinfo is None:
            raise ValueError()
        if value["kind"] not in ("video", "audio", "image", "sensor"):
            raise ValueError()
        if type(value["byte_size"]) is not int or not 1 <= value["byte_size"] <= MAX_CAPTURE_BYTES:
            raise ValueError()
        if len(value["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in value["sha256"]):
            raise ValueError()
        if not isinstance(value["content_type"], str) or not 1 <= len(value["content_type"]) <= 128 or any(ord(c) < 32 for c in value["content_type"]):
            raise ValueError()
        if not isinstance(value["metadata"], dict) or len(json.dumps(value["metadata"], ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()) > 8192:
            raise ValueError()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise SyncError("invalid capture manifest") from None
    return value


class Queue:
    def __init__(self, config):
        self.config = config
        self.root = Path(config["spool_dir"])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.root.is_symlink() or self.root.stat().st_uid != os.getuid():
            raise SyncError("spool must be a directory owned by the agent account")
        os.chmod(self.root, 0o700)
        self.entries = self.root / "captures"
        self.entries.mkdir(exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.root / "queue.sqlite3", timeout=30)
        os.chmod(self.root / "queue.sqlite3", 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS captures (
                capture_id TEXT PRIMARY KEY, manifest TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt REAL NOT NULL DEFAULT 0, last_error TEXT, receipt TEXT,
                verified_at REAL, purged INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS health (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        self.db.commit()

    def close(self):
        self.db.close()

    def set_error(self, message):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO health VALUES ('last_error', ?)", (message[:300],))

    @contextlib.contextmanager
    def lock(self, name):
        with open(self.root / (name + ".lock"), "a") as stream:
            os.chmod(stream.name, 0o600)
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SyncError(name + " already running") from None
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def disk_bytes(self):
        return sum(p.stat().st_size for p in self.entries.glob("*/*") if p.is_file() and not p.is_symlink())

    def reserve(self, expected_bytes=MAX_CAPTURE_BYTES):
        # Call while holding capture.lock. Includes partial/quarantined/retained files.
        if (self.disk_bytes() + expected_bytes > self.config["max_spool_bytes"]
                or shutil.disk_usage(self.root).free < self.config["min_free_bytes"] + expected_bytes):
            self.set_error("Capture storage full; recording paused until space is available")
            raise QueueFull("capture storage full; no recording started")
        capture_id = str(uuid.uuid4())
        folder = self.entries / capture_id
        folder.mkdir(mode=0o700)
        sync_directory(self.entries)
        return capture_id, folder

    def finalize(self, capture_id, folder, captured_at, kind="video", content_type="video/mp4", metadata=None):
        path = folder / "data"
        if folder != self.entries / capture_id or path.is_symlink() or not path.is_file():
            raise SyncError("capture output missing or unsafe")
        size = path.stat().st_size
        if not 1 <= size <= MAX_CAPTURE_BYTES:
            raise SyncError("capture is empty or exceeds 64 MiB; file retained locally")
        os.chmod(path, 0o600)
        with open(path, "rb") as stream:
            os.fsync(stream.fileno())
        manifest = validate_capture({"capture_id": capture_id, "captured_at": captured_at,
            "kind": kind, "content_type": content_type, "byte_size": size,
            "sha256": sha256_file(path), "metadata": metadata or {"format_version": 1}})
        # The manifest is the durable completion marker. Recovery can replay it if
        # power fails after this rename but before the SQLite transaction commits.
        atomic_json(folder / "manifest.json", manifest)
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO captures(capture_id, manifest) VALUES (?, ?)",
                            (capture_id, json.dumps(manifest)))
            self.db.execute("DELETE FROM health WHERE name='last_error'")
        return manifest

    def recover(self):
        for folder in self.entries.iterdir():
            if not folder.is_dir() or folder.is_symlink():
                continue
            marker = folder / "manifest.json"
            if not marker.is_file():
                # A live camera may still own this directory. Only flag unfinished
                # files after the capture lock is available (e.g. after reboot).
                try:
                    with self.lock("capture"):
                        if not marker.is_file():
                            self.set_error("Unfinished capture retained locally after interruption; inspect spool")
                except SyncError:
                    pass
                continue
            row = self.db.execute("SELECT capture_id FROM captures WHERE capture_id=?", (folder.name,)).fetchone()
            if row:
                continue
            try:
                if marker.is_symlink() or marker.stat().st_size > MAX_RESPONSE:
                    raise SyncError("unsafe capture manifest")
                manifest = validate_capture(json.loads(marker.read_text()))
                path = folder / "data"
                if (manifest["capture_id"] != folder.name or path.is_symlink() or not path.is_file()
                        or path.stat().st_size != manifest["byte_size"] or sha256_file(path) != manifest["sha256"]):
                    raise SyncError("capture file does not match manifest")
                with self.db:
                    self.db.execute("INSERT INTO captures(capture_id,manifest) VALUES (?,?)", (folder.name, json.dumps(manifest)))
            except (SyncError, OSError, ValueError):
                self.set_error("Damaged capture retained locally; inspect spool")

    def stats(self):
        pending = self.db.execute("SELECT manifest,last_error FROM captures WHERE state!='verified'").fetchall()
        error = self.db.execute("SELECT value FROM health WHERE name='last_error'").fetchone()
        result = {"queued_count": len(pending), "queued_bytes": sum(json.loads(row["manifest"])["byte_size"] for row in pending)}
        message = error[0] if error else next((row["last_error"] for row in pending if row["last_error"]), None)
        if message:
            result["last_error"] = message
        return result

    def due(self, now=None):
        return self.db.execute("SELECT * FROM captures WHERE state!='verified' AND next_attempt<=? ORDER BY next_attempt,capture_id LIMIT 1", (time.time() if now is None else now,)).fetchone()

    def failed(self, row, message):
        attempts = row["attempts"] + 1
        delay = min(900, 5 * 2**min(attempts - 1, 8)) + random.uniform(0, 5)
        with self.db:
            self.db.execute("UPDATE captures SET attempts=?,next_attempt=?,last_error=? WHERE capture_id=?",
                            (attempts, time.time() + delay, message[:300], row["capture_id"]))

    def verified(self, capture_id, receipt):
        # Commit receipt before cleanup; an interrupted cleanup remains repeatable.
        with self.db:
            self.db.execute("UPDATE captures SET state='verified',receipt=?,verified_at=?,last_error=NULL WHERE capture_id=?",
                            (json.dumps(receipt), time.time(), capture_id))

    def cleanup(self):
        cutoff = time.time() - self.config["retention_hours"] * 3600
        rows = self.db.execute("SELECT capture_id FROM captures WHERE state='verified' AND purged=0 AND verified_at<=?", (cutoff,)).fetchall()
        for row in rows:
            folder = self.entries / row["capture_id"]
            if folder.exists():
                shutil.rmtree(folder)
                sync_directory(self.entries)
            with self.db:
                self.db.execute("UPDATE captures SET purged=1 WHERE capture_id=?", (row["capture_id"],))


def connection(url, allow_http, timeout):
    try:
        parts = urlsplit(url)
        _ = parts.port
        if (parts.scheme not in (("http", "https") if allow_http else ("https",))
                or not parts.hostname or parts.username or parts.password or parts.fragment
                or any(ord(c) <= 32 for c in url)):
            raise ValueError()
        cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        kwargs = {"timeout": timeout}
        if parts.scheme == "https":
            kwargs["context"] = ssl.create_default_context()
        conn = cls(parts.hostname, parts.port, **kwargs)
        target = parts.path or "/"
        if parts.query:
            target += "?" + parts.query
        return conn, target
    except (TypeError, ValueError, AttributeError):
        raise SyncError("invalid or insecure service/upload URL") from None


class SyncClient:
    def __init__(self, config, identity):
        self.config = config
        self.device = {key: identity[key] for key in ("serial_number", "hardware_serial", "device_identity_secret")}

    def api(self, action, **fields):
        payload = json.dumps({"action": action, "device": self.device, **fields}, ensure_ascii=False,
                             separators=(",", ":"), allow_nan=False).encode()
        conn, target = connection(self.config["portal_url"] + "/api/device/sync", self.config.get("allow_http", False), self.config["timeout_seconds"])
        try:
            conn.request("POST", target, body=payload, headers={"Content-Type": "application/json", "Accept": "application/json"})
            response = conn.getresponse()
            # http.client never follows a redirect, and upstream bodies/URLs (which
            # could contain credentials) are deliberately excluded from logs.
            if response.status != 200:
                raise SyncError("sync service returned HTTP " + str(response.status), response.status)
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise SyncError("sync response exceeds size limit")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (OSError, http.client.HTTPException):
            raise SyncError("sync service unreachable or request timed out") from None
        except (ValueError, UnicodeError):
            raise SyncError("sync service returned invalid JSON") from None
        finally:
            conn.close()

    def upload(self, instructions, path, manifest):
        if not isinstance(instructions, dict) or instructions.get("method") != "PUT" or not isinstance(instructions.get("headers"), dict):
            raise SyncError("unsupported upload instructions")
        headers = {}
        allowed = {"content-type", "content-length", "if-none-match", "x-amz-checksum-sha256", "x-amz-meta-sha256", "x-amz-meta-capture-id", "x-ms-blob-type", "x-ms-version", "content-md5"}
        for name, value in instructions["headers"].items():
            if (not isinstance(name, str) or name.lower() not in allowed or not isinstance(value, str)
                    or any(ord(c) < 32 or ord(c) > 126 for c in value)):
                raise SyncError("unsafe upload headers")
            if name.lower() == "content-length":
                if value != str(manifest["byte_size"]):
                    raise SyncError("upload length does not match capture")
                continue
            if name.lower() == "if-none-match" and value != "*":
                raise SyncError("unsafe upload overwrite condition")
            headers[name] = value
        headers["Content-Length"] = str(manifest["byte_size"])
        conn, target = connection(instructions.get("url"), self.config.get("allow_http", False), self.config["timeout_seconds"])
        try:
            # A new direct HTTP connection gets ONLY provider upload headers. No
            # device identity, cookies, environment proxy or API authorization.
            with open(path, "rb") as stream:
                conn.putrequest("PUT", target)
                for name, value in headers.items():
                    conn.putheader(name, value)
                conn.endheaders()
                remaining = manifest["byte_size"]
                while remaining:
                    chunk = stream.read(min(256 * 1024, remaining))
                    if not chunk:
                        raise SyncError("capture changed during upload")
                    conn.send(chunk)
                    remaining -= len(chunk)
                response = conn.getresponse()
                if not 200 <= response.status < 300:
                    raise SyncError("storage returned HTTP " + str(response.status), response.status)
                # Do not consume unbounded provider response bodies.
        except (OSError, http.client.HTTPException):
            raise SyncError("storage unreachable or upload interrupted") from None
        finally:
            conn.close()

    @staticmethod
    def receipt(result, manifest):
        if not isinstance(result, dict):
            raise SyncError("invalid verification receipt; local capture retained")
        receipt = result.get("receipt") if isinstance(result, dict) else None
        if (result.get("state") != "verified" or result.get("capture_id") != manifest["capture_id"]
                or not isinstance(receipt, dict) or receipt.get("capture_id") != manifest["capture_id"]
                or receipt.get("sha256") != manifest["sha256"]
                or type(receipt.get("byte_size")) is not int or receipt["byte_size"] != manifest["byte_size"]):
            raise SyncError("invalid verification receipt; local capture retained")
        try:
            if datetime.fromisoformat(receipt["verified_at"].replace("Z", "+00:00")).tzinfo is None:
                raise ValueError()
        except (KeyError, ValueError, TypeError, AttributeError):
            raise SyncError("invalid verification timestamp; local capture retained") from None
        return receipt

    def deliver(self, queue, row):
        manifest = validate_capture(json.loads(row["manifest"]))
        path = queue.entries / row["capture_id"] / "data"
        if (path.is_symlink() or not path.is_file() or path.stat().st_size != manifest["byte_size"]
                or sha256_file(path) != manifest["sha256"]):
            raise SyncError("local capture failed integrity check; retained for inspection")
        if row["attempts"]:
            try:
                result = self.api("complete", capture_id=manifest["capture_id"], stats=queue.stats())
            except SyncError as exc:
                if exc.status not in (404, 409):
                    raise
            else:
                queue.verified(manifest["capture_id"], self.receipt(result, manifest))
                return
        result = self.api("prepare", capture=manifest, stats=queue.stats())
        if result.get("capture_id") != manifest["capture_id"]:
            raise SyncError("unexpected capture identity in upload response")
        if result.get("state") != "verified":
            if result.get("state") != "uploading":
                raise SyncError("unexpected upload state")
            self.upload(result.get("upload"), path, manifest)
            result = self.api("complete", capture_id=manifest["capture_id"], stats=queue.stats())
        queue.verified(manifest["capture_id"], self.receipt(result, manifest))


def run_once(queue, client):
    queue.recover()
    queue.cleanup()
    row = queue.due()
    succeeded = True
    if row:
        try:
            client.deliver(queue, row)
            LOG.info("capture %s verified in storage", row["capture_id"])
            queue.cleanup()
        except (SyncError, OSError) as exc:
            succeeded = False
            # OS errors can include local filenames, but never HTTP URLs/secrets.
            message = str(exc) if isinstance(exc, SyncError) else "local capture storage error"
            queue.failed(row, message)
            LOG.warning("capture %s: %s", row["capture_id"], message)
    try:
        result = client.api("status", stats=queue.stats())
        if result.get("ok") is not True:
            raise SyncError("unexpected sync status response")
    except SyncError as exc:
        succeeded = False
        LOG.warning("status report: %s", exc)
    return row is not None, succeeded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/hardhat/sync.json")
    parser.add_argument("--identity", default="/etc/hardhat/device.json")
    parser.add_argument("--hardware-serial-file", default=HARDWARE_SERIAL_FILE)
    parser.add_argument("--check-config", action="store_true")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--status", action="store_true", help="Print local queue health without a network call")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    os.umask(0o077)
    try:
        config = load_sync_config(args.config)
        identity = load_config(args.identity, args.hardware_serial_file)
        if args.check_config:
            LOG.info("sync configuration and Pi identity valid")
            return 0
        queue = Queue(config)
        if args.status:
            queue.recover()
            print(json.dumps(queue.stats()))
            queue.close()
            return 0
        client = SyncClient(config, identity)
        stop = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stop.set())
        try:
            with queue.lock("uploader"):
                while not stop.is_set():
                    worked, succeeded = run_once(queue, client)
                    if args.once:
                        return 0 if succeeded else 1
                    stop.wait(1 if worked else config["poll_seconds"])
        finally:
            queue.close()
        return 0
    except ConfigError as exc:
        LOG.error("%s", exc)
        return 78
    except (SyncError, OSError, sqlite3.Error) as exc:
        LOG.error("%s", exc if isinstance(exc, SyncError) else "local queue unavailable; check permissions and free space")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
