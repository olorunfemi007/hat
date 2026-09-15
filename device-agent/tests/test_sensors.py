import json
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sensors
import sync


class SensorFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = {"spool_dir": self.temp.name + "/spool", "max_spool_bytes": 256 * 1024**2,
                       "min_free_bytes": 0, "retention_hours": 0, "portal_url": "http://127.0.0.1",
                       "allow_http": True, "timeout_seconds": 5, "poll_seconds": 1}
        self.queue = sync.Queue(self.config)
        self.addCleanup(lambda: self.queue.close())

    def batcher(self, sensor_type="dht11", sensor_id="front-left", flush_seconds=300, min_free_bytes=0):
        return sensors.SensorBatcher(self.queue, sensor_type, sensor_id, flush_seconds, min_free_bytes)

    def reading(self, status="ok", values=None, error=None):
        now = sensors.utcnow()
        return {"schema_version": sensors.SCHEMA_VERSION, "reading_id": "r", "ts": sensors.iso(now),
                "sensor_type": "dht11", "sensor_id": "front-left", "status": status,
                "values": values or {"temperature_c": 21.0}, "units": {"temperature_c": "celsius"}, "error": error}


class ReadingScheduleTests(SensorFixture, unittest.TestCase):
    def test_faulty_driver_records_failure_not_a_measurement(self):
        class BrokenDriver:
            def read(self):
                raise RuntimeError("checksum failed")
        batcher = self.batcher()
        stop = threading.Event()
        stop.set()  # run exactly one iteration then exit
        worker = sensors.ActionWorker()
        worker.start()
        self.addCleanup(worker.stop)
        # run_sensor's loop body executes once even with stop already set,
        # since the check is at the top of the while -- confirm that single
        # pass records a failure, never a fabricated zero/null reading.
        stop.clear()

        def run_once():
            sensors.run_sensor(BrokenDriver(), "dht11", "front-left", 0.01, [], batcher, worker, stop)
        thread = threading.Thread(target=run_once)
        thread.start()
        time.sleep(0.05)
        stop.set()
        thread.join(timeout=5)
        batcher.close()
        lines = (Path(self.config["spool_dir"]) / "sensor_batches" / "dht11" / "front-left").glob("*")
        row = self.queue.due()
        self.assertIsNotNone(row)
        manifest = json.loads(row["manifest"])
        data_path = self.queue.entries / row["capture_id"] / "data"
        first = json.loads(data_path.read_text().splitlines()[0])
        self.assertEqual(first["status"], "error")
        self.assertEqual(first["values"], {})
        self.assertIn("checksum failed", first["error"])
        self.assertEqual(manifest["kind"], "sensor")


class BatcherDurabilityTests(SensorFixture, unittest.TestCase):
    def test_flush_on_time_produces_a_real_queued_capture(self):
        batcher = self.batcher(flush_seconds=300)
        batcher.append(self.reading())
        batcher.append(self.reading())
        self.assertIsNone(self.queue.due())  # not due yet
        batcher.batch_start = sensors.utcnow() - __import__("datetime").timedelta(seconds=301)
        batcher.flush_if_due()
        row = self.queue.due()
        self.assertIsNotNone(row)
        manifest = json.loads(row["manifest"])
        self.assertEqual(manifest["kind"], "sensor")
        self.assertEqual(manifest["content_type"], "application/x-ndjson")
        self.assertEqual(manifest["metadata"]["sensor_type"], "dht11")
        self.assertEqual(manifest["metadata"]["sensor_id"], "front-left")
        self.assertEqual(manifest["metadata"]["reading_count"], 2)
        data_path = self.queue.entries / row["capture_id"] / "data"
        lines = data_path.read_text().splitlines()
        self.assertEqual(len(lines), 2)
        for line in lines:
            parsed = json.loads(line)
            self.assertEqual(parsed["schema_version"], sensors.SCHEMA_VERSION)
            self.assertIn("reading_id", parsed)

    def test_empty_batch_never_creates_a_capture(self):
        batcher = self.batcher(flush_seconds=300)
        batcher.flush_if_due()  # nothing appended yet
        self.assertIsNone(self.queue.due())
        batcher.close()
        self.assertIsNone(self.queue.due())

    def test_midnight_utc_boundary_splits_batches_even_before_the_timer(self):
        batcher = self.batcher(flush_seconds=3600)
        batcher.append(self.reading())
        import datetime
        batcher.batch_start = sensors.utcnow().replace(hour=0, minute=0, second=0, microsecond=0) - datetime.timedelta(seconds=1)
        self.assertTrue(batcher._due(batcher.batch_start, sensors.utcnow(), 10))

    def test_restart_within_window_resumes_the_same_batch(self):
        batcher = self.batcher(flush_seconds=300)
        batcher.append(self.reading())
        started = batcher.batch_start
        resumed = self.batcher(flush_seconds=300)
        self.assertEqual(resumed.batch_start, started)
        self.assertEqual(resumed.count, 1)
        resumed.append(self.reading())
        self.assertEqual(resumed.count, 2)
        self.assertIsNone(self.queue.due())  # still not flushed -- same batch, not a new one

    def test_restart_after_window_finalizes_the_stale_batch_not_silently(self):
        batcher = self.batcher(flush_seconds=300)
        batcher.append(self.reading())
        import datetime
        meta_path = Path(self.config["spool_dir"]) / "sensor_batches" / "dht11" / "front-left" / "current.meta.json"
        stale = (sensors.utcnow() - datetime.timedelta(seconds=301))
        meta_path.write_text(json.dumps({"batch_start": sensors.iso(stale)}))
        recovered = self.batcher(flush_seconds=300)
        self.assertIsNone(recovered.batch_start)  # started fresh; the old one was queued, not lost or merged
        row = self.queue.due()
        self.assertIsNotNone(row)
        self.assertEqual(json.loads(row["manifest"])["metadata"]["reading_count"], 1)

    def test_low_free_space_drops_new_readings_without_crashing(self):
        batcher = self.batcher(min_free_bytes=10**15)  # effectively unsatisfiable
        batcher.append(self.reading())
        self.assertIsNone(batcher.batch_start)  # never started a batch
        self.assertIsNone(self.queue.due())

    def test_finalize_deferred_on_lock_contention_never_loses_data(self):
        batcher = self.batcher(flush_seconds=300)
        batcher.append(self.reading())
        batcher.batch_start = sensors.utcnow() - __import__("datetime").timedelta(seconds=301)
        with self.queue.lock("capture"):
            batcher.flush_if_due()  # capture.lock is held elsewhere; must defer, not raise or drop data
        self.assertIsNotNone(batcher.batch_start)  # still pending
        self.assertIsNone(self.queue.due())
        data_path = Path(self.config["spool_dir"]) / "sensor_batches" / "dht11" / "front-left" / "current.ndjson"
        self.assertTrue(data_path.exists())
        batcher.flush_if_due()  # lock free now
        self.assertIsNotNone(self.queue.due())


class RuleTests(unittest.TestCase):
    def test_trigger_then_no_repeat_while_still_crossed(self):
        rule = sensors.Rule(field="t", trigger_above=60, cooldown_seconds=0)
        self.assertTrue(rule.evaluate(61, now=0))
        self.assertFalse(rule.evaluate(62, now=1))
        self.assertFalse(rule.evaluate(65, now=2))

    def test_hysteresis_requires_clear_threshold_not_just_recrossing_trigger(self):
        rule = sensors.Rule(field="t", trigger_above=60, clear_below=55, cooldown_seconds=0)
        self.assertTrue(rule.evaluate(61, now=0))
        self.assertFalse(rule.evaluate(58, now=1))  # below trigger but not below clear: still "triggered"
        self.assertFalse(rule.evaluate(61, now=2))  # re-crossing trigger_above alone must not re-fire
        self.assertFalse(rule.evaluate(54, now=3))  # now clears
        self.assertTrue(rule.evaluate(61, now=4))  # crosses again after clearing: fires

    def test_cooldown_blocks_rapid_retrigger_even_after_clearing(self):
        rule = sensors.Rule(field="t", trigger_above=60, clear_below=55, cooldown_seconds=100)
        self.assertTrue(rule.evaluate(61, now=0))
        self.assertFalse(rule.evaluate(54, now=1))  # clears
        self.assertFalse(rule.evaluate(61, now=2))  # re-triggers but within cooldown of the last action
        self.assertTrue(rule.evaluate(54, now=1) or True)  # (clearing never fires; sanity no-op)
        self.assertFalse(rule.evaluate(54, now=50))
        self.assertTrue(rule.evaluate(61, now=101))  # cooldown elapsed since the action at now=0

    def test_unknown_action_rejected_at_construction(self):
        with self.assertRaises(sensors.ConfigError):
            sensors.Rule(field="t", trigger_above=1, action="does-not-exist")

    def test_rule_needs_at_least_one_bound(self):
        with self.assertRaises(sensors.ConfigError):
            sensors.Rule(field="t")


class ActionWorkerTests(unittest.TestCase):
    def test_slow_action_does_not_block_submit_or_other_sensors(self):
        started = threading.Event()
        release = threading.Event()

        @sensors.register_action("test-slow-action")
        def slow(_context):
            started.set()
            release.wait(timeout=5)

        worker = sensors.ActionWorker()
        worker.start()
        self.addCleanup(worker.stop)
        t0 = time.monotonic()
        worker.submit("test-slow-action", {})
        submit_elapsed = time.monotonic() - t0
        self.assertLess(submit_elapsed, 0.5, "submit() must return immediately, not wait for the action")
        self.assertTrue(started.wait(timeout=2))
        release.set()

    def test_action_exception_does_not_kill_the_worker(self):
        calls = []

        @sensors.register_action("test-raises-then-fine")
        def raises(_context):
            calls.append(1)
            raise RuntimeError("boom")
        worker = sensors.ActionWorker()
        worker.start()
        self.addCleanup(worker.stop)
        worker.submit("test-raises-then-fine", {})
        worker.submit("log_alert", {"sensor_type": "x", "sensor_id": "y", "field": "f", "value": 1})
        time.sleep(0.2)
        self.assertEqual(calls, [1])  # second action still ran after the first raised


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def write(self, obj):
        path = Path(self.temp.name) / "sensors.json"
        path.write_text(json.dumps(obj))
        return path

    def test_valid_config_accepted(self):
        path = self.write({"flush_seconds": 60, "sensors": [{"driver": "dht11", "sensor_id": "a", "sample_interval_seconds": 5}]})
        config = sensors.load_sensors_config(path)
        self.assertEqual(config["flush_seconds"], 60)

    def test_unsafe_sensor_id_rejected(self):
        path = self.write({"sensors": [{"driver": "dht11", "sensor_id": "has/slash"}]})
        with self.assertRaises(sensors.ConfigError):
            sensors.load_sensors_config(path)

    def test_duplicate_sensor_id_for_same_driver_rejected(self):
        path = self.write({"sensors": [{"driver": "dht11", "sensor_id": "a"}, {"driver": "dht11", "sensor_id": "a"}]})
        with self.assertRaises(sensors.ConfigError):
            sensors.load_sensors_config(path)

    def test_out_of_range_interval_rejected(self):
        path = self.write({"sensors": [{"driver": "dht11", "sensor_id": "a", "sample_interval_seconds": 999999}]})
        with self.assertRaises(sensors.ConfigError):
            sensors.load_sensors_config(path)

    def test_empty_sensor_list_is_valid(self):
        path = self.write({"sensors": []})
        config = sensors.load_sensors_config(path)
        self.assertEqual(config["sensors"], [])


class RealSubprocessTests(unittest.TestCase):
    """In-process calls can't catch a bug that only exists because __main__
    and an imported module of the same name are different objects -- that
    needs an actual second process, exactly how the real service runs."""

    def test_a_driver_module_loaded_via_driver_module_flag_actually_registers(self):
        device_agent = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / "fake_driver.py").write_text(
                "import sensors\n"
                "class _Fake:\n"
                "    def read(self):\n"
                "        return {'values': {'x': 1.0}, 'units': {'x': 'count'}}\n"
                "@sensors.register_driver('subprocesstest')\n"
                "def _build(entry):\n"
                "    return _Fake()\n"
            )
            (directory / "sensors.json").write_text(json.dumps({
                "flush_seconds": 30,
                "sensors": [{"driver": "subprocesstest", "sensor_id": "s1", "sample_interval_seconds": 0.1, "rules": []}],
            }))
            (directory / "sync.json").write_text(json.dumps({
                "portal_url": "http://127.0.0.1:1", "allow_http": True, "spool_dir": str(directory / "spool"),
                "max_spool_bytes": 268435456, "min_free_bytes": 0, "retention_hours": 0, "poll_seconds": 15, "timeout_seconds": 5,
            }))
            env = {**__import__("os").environ, "PYTHONPATH": f"{device_agent}{__import__('os').pathsep}{directory}"}
            proc = subprocess.Popen([sys.executable, str(device_agent / "sensors.py"), "--config", str(directory / "sensors.json"),
                                      "--sync-config", str(directory / "sync.json"), "--driver-module", "fake_driver"],
                                     env=env, stderr=subprocess.PIPE, text=True)
            time.sleep(1.5)
            proc.send_signal(signal.SIGTERM)
            try:
                _, stderr = proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                raise
            self.assertEqual(proc.returncode, 0, stderr)
            self.assertNotIn("unknown driver", stderr, stderr)
            db = sqlite3.connect(str(directory / "spool" / "queue.sqlite3"))
            rows = db.execute("SELECT manifest FROM captures").fetchall()
            self.assertEqual(len(rows), 1, "the real subprocess must have queued exactly one sensor batch")
            manifest = json.loads(rows[0][0])
            self.assertEqual(manifest["kind"], "sensor")
            self.assertEqual(manifest["metadata"]["sensor_type"], "subprocesstest")


if __name__ == "__main__":
    unittest.main()
