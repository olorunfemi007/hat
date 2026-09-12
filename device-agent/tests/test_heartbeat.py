import io
import json
import logging
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib import error, request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import heartbeat as agent
from provision_device import provision


def config():
    return {"serial_number": "HAT-001", "hardware_serial": "000000001234abcd",
            "device_identity_secret": "a" * 40, "supabase_url": "https://example.supabase.co",
            "publishable_key": "sb_publishable_test"}


class ConfigTests(unittest.TestCase):
    def test_physical_pairing_and_private_file(self):
        with tempfile.TemporaryDirectory() as d:
            path, serial = Path(d)/"device.json", Path(d)/"serial"
            path.write_text(json.dumps(config()))
            path.chmod(0o600)
            serial.write_bytes(b"000000001234abcd\x00")
            self.assertEqual(agent.load_config(path, serial), config())
            serial.write_text("000000001234abce")
            with self.assertRaisesRegex(agent.ConfigError, "different Pi"):
                agent.load_config(path, serial)
            path.chmod(0o644)
            with self.assertRaisesRegex(agent.ConfigError, "private file"):
                agent.load_config(path, serial)

    def test_invalid_config_and_admin_keys_rejected(self):
        for change in [{"publishable_key": "sb_secret_never-on-device"},
                       {"device_identity_secret": ""}, {"hardware_serial": "bogus"},
                       {"extra": "unknown"}, {"allow_http": "true"}]:
            with self.subTest(change=change), self.assertRaises(agent.ConfigError):
                agent.validate_config(dict(config(), **change))

    def test_https_required_unless_explicit_development_setting(self):
        for url in ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?key=x"]:
            with self.subTest(url=url), self.assertRaises(agent.ConfigError):
                agent.validate_url(url)
        self.assertEqual(agent.validate_url("http://127.0.0.1:54321", True), "http://127.0.0.1:54321")

    def test_legacy_anon_key_accepted_but_service_role_rejected(self):
        import base64
        def key(role):
            return "header." + base64.urlsafe_b64encode(json.dumps({"role": role}).encode()).decode().rstrip("=") + ".sig"
        self.assertEqual(agent.validate_public_key(key("anon")), key("anon"))
        with self.assertRaises(agent.ConfigError):
            agent.validate_public_key(key("service_role"))


class HeartbeatTests(unittest.TestCase):
    def test_success_and_payload(self):
        for status in ["unclaimed", "active"]:
            with patch.object(agent, "rpc", return_value=[{"serial_number": "HAT-001", "status": status, "last_seen_at": "2026-09-10T00:00:00Z"}]) as rpc:
                self.assertEqual(agent.heartbeat(config()), status)
                self.assertEqual(rpc.call_args.args[3], {"p_serial_number": "HAT-001", "p_device_identity_secret": "a" * 40,
                                                          "p_hardware_serial": "000000001234abcd"})

    def test_http_200_empty_rows_is_rejection(self):
        with patch.object(agent, "rpc", return_value=[]), self.assertRaises(agent.HeartbeatError) as failure:
            agent.heartbeat(config())
        self.assertTrue(failure.exception.rejected)

    def test_malformed_or_wrong_device_results_are_not_success(self):
        for result in [None, {}, [{}], [{"serial_number": "OTHER", "status": "active", "last_seen_at": "now"}],
                       [{"serial_number": "HAT-001", "status": "offline", "last_seen_at": "now"}]]:
            with self.subTest(result=result), patch.object(agent, "rpc", return_value=result), self.assertRaises(agent.HeartbeatError):
                agent.heartbeat(config())

    def test_api_key_header_and_no_redirects(self):
        with patch.object(agent.request, "build_opener") as make:
            make.return_value.open.return_value = io.BytesIO(b"[]")
            agent.rpc("https://example.com", "sb_publishable_test", "device_heartbeat", {})
            req = make.return_value.open.call_args.args[0]
            self.assertEqual(req.get_header("Apikey"), "sb_publishable_test")
            self.assertIsNone(req.get_header("Authorization"))
            self.assertEqual(req.get_method(), "POST")
            self.assertIsInstance(make.call_args.args[1], agent.NoRedirect)
        self.assertIsNone(agent.NoRedirect().redirect_request(request.Request("https://a.test"), None, 307, "", {}, "http://b.test"))

    def test_transport_failures_never_log_response_or_secret(self):
        for failure in [error.URLError("secret-data"), error.HTTPError("https://example.com", 401, "secret-data", {}, None)]:
            with patch.object(agent.request, "build_opener") as make:
                make.return_value.open.side_effect = failure
                with self.assertRaises(agent.HeartbeatError) as raised:
                    agent.rpc("https://example.com", "sb_publishable_test", "device_heartbeat", {})
                self.assertNotIn("secret-data", str(raised.exception))

    def test_invalid_and_oversized_response(self):
        for body in [b"not-json", b"x" * (agent.MAX_RESPONSE+1)]:
            with patch.object(agent.request, "build_opener") as make:
                make.return_value.open.return_value = io.BytesIO(body)
                with self.assertRaises(agent.HeartbeatError):
                    agent.rpc("https://example.com", "sb_publishable_test", "device_heartbeat", {})

    def test_network_retry_then_recovery_and_graceful_stop(self):
        class Stop:
            waits = []
            def is_set(self): return len(self.waits) >= 3
            def wait(self, seconds): self.waits.append(seconds)
        stop = Stop()
        with patch.object(agent, "heartbeat", side_effect=[agent.HeartbeatError("offline"), agent.HeartbeatError("offline"), "active"]) as send:
            agent.run(config(), stop, send=send, jitter=lambda *_: 0)
        self.assertEqual(stop.waits, [5, 10, 60])

    def test_rejected_identity_backs_off_beyond_throttle_window(self):
        class Stop:
            delay = None
            def is_set(self): return self.delay is not None
            def wait(self, seconds): self.delay = seconds
        stop = Stop()
        def reject(_): raise agent.HeartbeatError("rejected", rejected=True)
        agent.run(config(), stop, send=reject, jitter=lambda *_: 0)
        self.assertGreater(stop.delay, 15*60)


class ProvisionTests(unittest.TestCase):
    def test_export_keeps_admin_key_off_pi_and_identity_off_label(self):
        with tempfile.TemporaryDirectory() as d, patch("provision_device.rpc", return_value=[{
            "serial_number": "HAT-001", "claim_code": "b" * 40, "device_identity_secret": "a" * 40}]):
            directory = provision("https://example.com", "sb_publishable_test", "sb_secret_operator",
                                  "000000001234abcd", "HAT-001", "https://portal.example.com", Path(d)/"new")
            device = json.loads((directory/"device.json").read_text())
            self.assertEqual(device["hardware_serial"], "000000001234abcd")
            self.assertNotIn("sb_secret_operator", (directory/"device.json").read_text())
            self.assertNotIn("a" * 40, (directory/"claim-label.txt").read_text())
            self.assertIn("claim_code=" + "b"*40, (directory/"claim-label.txt").read_text())
            self.assertFalse((directory/"INCOMPLETE.txt").exists())
            self.assertEqual((directory/"device.json").stat().st_mode & 0o777, 0o600)

    def test_never_overwrites_or_retries_ambiguous_provisioning(self):
        with tempfile.TemporaryDirectory() as d, patch("provision_device.rpc", side_effect=agent.HeartbeatError("timeout")) as rpc:
            args=("https://example.com", "sb_publishable_test", "sb_secret_operator", "000000001234abcd", "HAT-001", "https://portal.example.com", Path(d)/"new")
            with self.assertRaises(agent.HeartbeatError): provision(*args)
            self.assertTrue((Path(d)/"new/INCOMPLETE.txt").exists())
            with self.assertRaises(FileExistsError): provision(*args)
            self.assertEqual(rpc.call_count, 1)


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
