import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import capture
import sync


class QueueFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = {"spool_dir": self.temp.name + "/spool", "max_spool_bytes": 256 * 1024**2,
                       "min_free_bytes": 0, "retention_hours": 0, "portal_url": "http://127.0.0.1",
                       "allow_http": True, "timeout_seconds": 5, "poll_seconds": 1}
        self.queue = sync.Queue(self.config)
        self.addCleanup(lambda: self.queue.close())

    def enqueue(self, data=b"capture bytes"):
        capture_id, folder = self.queue.reserve()
        (folder / "data").write_bytes(data)
        manifest = self.queue.finalize(capture_id, folder, sync.utc_now())
        return manifest, folder


class QueueTests(QueueFixture, unittest.TestCase):
    def test_reopen_survives_reboot_with_retry_state(self):
        manifest, folder = self.enqueue()
        row = self.queue.due()
        self.queue.failed(row, "storage unavailable")
        self.queue.close()
        self.queue = sync.Queue(self.config)
        self.queue.recover()
        self.assertIsNone(self.queue.due())
        row = self.queue.due(time.time() + 1000)
        self.assertEqual(row["capture_id"], manifest["capture_id"])
        self.assertEqual(row["attempts"], 1)
        self.assertEqual(self.queue.stats()["queued_count"], 1)
        self.assertTrue((folder / "data").exists())

    def test_completion_marker_recovers_database_commit_crash(self):
        manifest, _ = self.enqueue()
        with self.queue.db:
            self.queue.db.execute("DELETE FROM captures")
        self.queue.close()
        self.queue = sync.Queue(self.config)
        self.queue.recover()
        self.queue.recover()
        self.assertEqual(self.queue.stats()["queued_count"], 1)
        self.assertEqual(self.queue.due()["capture_id"], manifest["capture_id"])

    def test_crash_partial_retained_but_never_queued(self):
        _, folder = self.queue.reserve()
        (folder / "source.part").write_bytes(b"not finalized")
        self.queue.recover()
        self.assertEqual(self.queue.stats()["queued_count"], 0)
        self.assertIn("Unfinished", self.queue.stats()["last_error"])
        self.assertTrue((folder / "source.part").exists())

    def test_active_recording_is_not_reported_as_crash(self):
        with self.queue.lock("capture"):
            self.queue.reserve()
            self.queue.recover()
            self.assertNotIn("last_error", self.queue.stats())

    def test_corrupt_orphan_not_recovered(self):
        _, folder = self.enqueue()
        with self.queue.db:
            self.queue.db.execute("DELETE FROM captures")
        (folder / "data").write_bytes(b"tampered")
        self.queue.recover()
        self.assertEqual(self.queue.stats()["queued_count"], 0)
        self.assertIn("Damaged", self.queue.stats()["last_error"])

    def test_disk_full_and_spool_limit_stop_capture_without_deleting(self):
        _, folder = self.enqueue()
        with patch("sync.shutil.disk_usage") as usage:
            usage.return_value.free = 0
            with self.assertRaises(sync.QueueFull):
                self.queue.reserve()
        self.config["max_spool_bytes"] = 1
        with self.assertRaises(sync.QueueFull):
            self.queue.reserve()
        self.assertTrue((folder / "data").exists())
        self.assertIn("full", self.queue.stats()["last_error"])

    def test_unverified_capture_never_cleaned_and_verified_retention_honored(self):
        manifest, folder = self.enqueue()
        self.queue.cleanup()
        self.assertTrue((folder / "data").exists())
        receipt = {key: manifest[key] for key in ("capture_id", "sha256", "byte_size")}
        receipt["verified_at"] = sync.utc_now()
        self.queue.verified(manifest["capture_id"], receipt)
        self.config["retention_hours"] = 24
        self.queue.cleanup()
        self.assertTrue((folder / "data").exists())
        self.config["retention_hours"] = 0
        self.queue.cleanup()
        self.assertFalse(folder.exists())
        self.assertEqual(self.queue.stats()["queued_count"], 0)
        self.assertEqual(self.queue.db.execute("SELECT purged FROM captures").fetchone()[0], 1)

    def test_private_permissions(self):
        _, folder = self.enqueue()
        for path, mode in [(self.queue.root, 0o700), (folder, 0o700), (folder / "data", 0o600),
                           (folder / "manifest.json", 0o600), (self.queue.root / "queue.sqlite3", 0o600)]:
            self.assertEqual(path.stat().st_mode & 0o777, mode)

    def test_custom_camera_unique_files_and_success_only(self):
        script = Path(self.temp.name) / "camera.py"
        script.write_text("import pathlib,sys\npathlib.Path(sys.argv[1]).write_bytes(b'fake finalized mp4')\n")
        command = f"{sys.executable} {script} {{output}}"
        first = capture.record(self.queue, camera_command=command, source_format="mp4")
        second = capture.record(self.queue, camera_command=command, source_format="mp4")
        self.assertNotEqual(first["capture_id"], second["capture_id"])
        self.assertEqual(self.queue.stats()["queued_count"], 2)
        script.write_text("import pathlib,sys\npathlib.Path(sys.argv[1]).write_bytes(b'partial')\nsys.exit(1)\n")
        with self.assertRaises(sync.SyncError):
            capture.record(self.queue, camera_command=command, source_format="mp4")
        self.assertEqual(self.queue.stats()["queued_count"], 2)
        self.assertEqual(len(list(self.queue.entries.glob("*/source.part"))), 1)

    def test_camera_off_requests_graceful_close_before_enqueue(self):
        script = Path(self.temp.name) / "camera.py"
        script.write_text("import pathlib,sys,signal,time\n"
                          "p=pathlib.Path(sys.argv[1])\n"
                          "def close(*_):\n p.write_bytes(b'closed recording')\n sys.exit(0)\n"
                          "signal.signal(signal.SIGINT,close)\n"
                          "p.write_bytes(b'in progress')\n"
                          "while True: time.sleep(0.05)\n")
        stop = threading.Event()
        timer = threading.Timer(0.5, stop.set)
        timer.start()
        try:
            manifest = capture.record(self.queue, camera_command=f"{sys.executable} {script} {{output}}",
                                      source_format="mp4", stop=stop)
        finally:
            timer.cancel()
        self.assertEqual(self.queue.stats()["queued_count"], 1)
        self.assertEqual((self.queue.entries / manifest["capture_id"] / "data").read_bytes(), b"closed recording")

    def test_config_rejects_insecure_url_unknown_fields_and_invalid_limits(self):
        path = Path(self.temp.name) / "sync.json"
        for value in [{"portal_url": "http://example.com"}, {"portal_url": "https://example.com", "token": "secret"},
                      {"portal_url": "https://example.com", "max_spool_bytes": -1},
                      {"portal_url": "https://example.com", "allow_http": "true"}]:
            path.write_text(json.dumps(value))
            with self.assertRaises(sync.ConfigError):
                sync.load_sync_config(path)
        path.write_text('{"portal_url":"https://example.com"}')
        self.assertEqual(sync.load_sync_config(path)["portal_url"], "https://example.com")


class FakeService:
    def __init__(self):
        self.manifests = {}
        self.objects = {}
        self.put_count = 0
        self.prepare_count = 0
        self.expire_once = False
        self.complete_fail_once = False
        self.bad_receipt = False
        self.redirect_api = False
        self.redirect_upload = False
        self.upload_headers = []
        self.upload_bodies = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def respond(self, status, data):
                body = json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if owner.redirect_api:
                    self.send_response(307)
                    self.send_header("Location", owner.url + "/stolen")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if self.path != "/api/device/sync":
                    return self.respond(500, {"unexpected": True})
                self.server.seen_device = data["device"]
                if data["action"] == "status":
                    return self.respond(200, {"ok": True})
                if data["action"] == "prepare":
                    manifest = data["capture"]
                    owner.manifests[manifest["capture_id"]] = manifest
                    owner.prepare_count += 1
                    return self.respond(200, {"capture_id": manifest["capture_id"], "state": "uploading", "upload": {
                        "url": owner.url + "/object/" + manifest["capture_id"], "method": "PUT", "headers": {
                            "content-type": manifest["content_type"], "content-length": str(manifest["byte_size"]), "if-none-match": "*"}}})
                capture_id = data["capture_id"]
                if capture_id not in owner.objects:
                    return self.respond(409, {"error": "not uploaded"})
                if owner.complete_fail_once:
                    owner.complete_fail_once = False
                    return self.respond(503, {"error": "temporary outage"})
                manifest = owner.manifests[capture_id]
                receipt = {key: manifest[key] for key in ("capture_id", "sha256", "byte_size")}
                receipt["verified_at"] = sync.utc_now()
                if owner.bad_receipt:
                    receipt["sha256"] = "0" * 64
                return self.respond(200, {"capture_id": capture_id, "state": "verified", "receipt": receipt})

            def do_PUT(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                owner.upload_headers.append(dict(self.headers))
                owner.upload_bodies.append(body)
                owner.put_count += 1
                if owner.redirect_upload:
                    self.send_response(307)
                    self.send_header("Location", owner.url + "/stolen")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if owner.expire_once:
                    owner.expire_once = False
                    return self.respond(403, {"error": "expired"})
                capture_id = self.path.rsplit("/", 1)[-1]
                manifest = owner.manifests[capture_id]
                if hashlib.sha256(body).hexdigest() != manifest["sha256"]:
                    return self.respond(400, {"error": "corrupt"})
                owner.objects[capture_id] = body
                return self.respond(200, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class UploadTests(QueueFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.server = FakeService()
        self.addCleanup(self.server.close)
        self.config["portal_url"] = self.server.url
        self.identity = {"serial_number": "HAT-TEST", "hardware_serial": "000000001234abcd", "device_identity_secret": "a" * 40}
        self.client = sync.SyncClient(self.config, self.identity)

    def retry_immediately(self):
        with self.queue.db:
            self.queue.db.execute("UPDATE captures SET next_attempt=0")

    def test_upload_verified_and_credentials_never_sent_to_storage(self):
        manifest, folder = self.enqueue(b"x" * (700 * 1024))
        self.client.deliver(self.queue, self.queue.due())
        self.assertEqual(self.queue.stats()["queued_count"], 0)
        self.assertTrue((folder / "data").exists())
        sent = json.dumps(self.server.upload_headers)
        self.assertNotIn(self.identity["device_identity_secret"], sent)
        self.assertNotIn("Authorization", sent)
        self.assertNotIn("Cookie", sent)
        self.assertEqual(self.server.objects[manifest["capture_id"]], b"x" * (700 * 1024))

    def test_expired_upload_permission_survives_restart_and_retries(self):
        manifest, folder = self.enqueue()
        self.server.expire_once = True
        sync.run_once(self.queue, self.client)
        self.assertTrue((folder / "data").exists())
        self.assertEqual(self.queue.stats()["queued_count"], 1)
        self.queue.close()
        self.queue = sync.Queue(self.config)
        self.retry_immediately()
        sync.run_once(self.queue, self.client)
        self.assertEqual(self.queue.stats()["queued_count"], 0)
        self.assertEqual(self.server.put_count, 2)
        self.assertEqual(self.server.prepare_count, 2)

    def test_lost_complete_response_does_not_reupload_successful_object(self):
        self.enqueue()
        self.server.complete_fail_once = True
        sync.run_once(self.queue, self.client)
        self.assertEqual(self.queue.stats()["queued_count"], 1)
        self.retry_immediately()
        sync.run_once(self.queue, self.client)
        self.assertEqual(self.server.put_count, 1)
        self.assertEqual(self.queue.stats()["queued_count"], 0)

    def test_invalid_receipt_keeps_capture(self):
        _, folder = self.enqueue()
        self.server.bad_receipt = True
        sync.run_once(self.queue, self.client)
        self.queue.cleanup()
        self.assertEqual(self.queue.stats()["queued_count"], 1)
        self.assertTrue((folder / "data").exists())
        self.assertIn("invalid verification receipt", self.queue.stats()["last_error"])

    def test_redirects_are_rejected_for_api_and_storage(self):
        self.enqueue()
        self.server.redirect_api = True
        with self.assertRaises(sync.SyncError) as caught:
            self.client.api("status", stats={})
        self.assertEqual(caught.exception.status, 307)
        self.server.redirect_api = False
        self.server.redirect_upload = True
        with self.assertRaises(sync.SyncError) as caught:
            self.client.deliver(self.queue, self.queue.due())
        self.assertEqual(caught.exception.status, 307)
        self.assertEqual(self.server.put_count, 1)
        self.assertEqual(self.queue.stats()["queued_count"], 1)

    def test_local_tampering_never_reaches_storage(self):
        _, folder = self.enqueue()
        (folder / "data").write_bytes(b"corrupted capture")
        with self.assertRaisesRegex(sync.SyncError, "integrity"):
            self.client.deliver(self.queue, self.queue.due())
        self.assertEqual(self.server.put_count, 0)

    def test_unsafe_provider_headers_and_insecure_urls_refused(self):
        manifest, folder = self.enqueue()
        for headers in [{"Authorization": "Bearer secret"}, {"Cookie": "session=secret"},
                        {"content-length": "999"}, {"if-none-match": "anything"}]:
            with self.assertRaises(sync.SyncError):
                self.client.upload({"url": self.server.url, "method": "PUT", "headers": headers}, folder / "data", manifest)
        self.config["allow_http"] = False
        with self.assertRaises(sync.SyncError):
            self.client.api("status")


if __name__ == "__main__":
    unittest.main()
