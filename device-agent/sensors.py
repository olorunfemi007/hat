#!/usr/bin/env python3
"""Durable, extensible continuous-sensor sampling, local reaction, and batched sync.

Three concerns are deliberately independent, per-sensor:
  - sampling: each sensor is read on its own interval, in its own thread.
  - reaction: every reading is rule-checked immediately (thresholds, hysteresis,
    cooldown); the actual action runs on a separate worker so a slow action
    can never delay sampling of this or any other sensor.
  - archival: readings are appended to a durable, disk-backed NDJSON batch as
    they're taken; the batch is flushed (handed to sync.py's existing durable
    queue, unmodified) on a timer, at a UTC-midnight boundary, or a hard size
    ceiling -- never on the same clock as reaction.

New hardware = one small driver (read() returns values, or raises on failure
-- failures are recorded as failures, never coerced into a zero/null value).
New sensor instances = config only; batching, durability and upload are
already generic across every sensor_type/sensor_id (see 0018_sensor_capture_keys.sql).
"""
import argparse
import importlib
import json
import logging
import os
from pathlib import Path
import queue
import shutil
import signal
import sys
import threading
import time
import uuid
from datetime import datetime, timezone

from heartbeat import ConfigError
from sync import Queue, SyncError, atomic_json, sync_directory, load_sync_config

LOG = logging.getLogger("hardhat-sensors")
SCHEMA_VERSION = 1
SAFE_LABEL = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_BATCH_READINGS = 20000  # independent hard ceiling; the timer/day-boundary are the normal triggers
MAX_BATCH_BYTES = 8 * 1024 * 1024  # NDJSON batches are tiny by design; this is already generous


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SensorError(Exception):
    pass


# --------------------------------------------------------------------------
# Driver + action registries. New hardware registers a driver factory here
# (or via --driver-module for out-of-tree drivers); everything downstream
# (batching, rules, sync) already works for any sensor_type/sensor_id.
# --------------------------------------------------------------------------
DRIVERS = {}
ACTIONS = {}


def register_driver(name):
    def decorator(factory):
        DRIVERS[name] = factory
        return factory
    return decorator


def register_action(name):
    def decorator(fn):
        ACTIONS[name] = fn
        return fn
    return decorator


@register_action("log_alert")
def _log_alert(context):
    LOG.warning("sensor rule triggered: %s/%s field=%s value=%s", context["sensor_type"],
                context["sensor_id"], context["field"], context["value"])


# --------------------------------------------------------------------------
# Rule evaluation: cheap, synchronous, run on every reading. Hysteresis uses
# separate trigger/clear thresholds so a value sitting near one boundary
# doesn't fire repeatedly; cooldown additionally rate-limits the action itself.
# --------------------------------------------------------------------------
class Rule:
    def __init__(self, field, trigger_above=None, trigger_below=None,
                 clear_above=None, clear_below=None, cooldown_seconds=60, action="log_alert"):
        if trigger_above is None and trigger_below is None:
            raise ConfigError("a rule needs trigger_above or trigger_below")
        if action not in ACTIONS:
            raise ConfigError(f"unknown action: {action}")
        self.field = field
        self.trigger_above = trigger_above
        self.trigger_below = trigger_below
        # clear_below pairs with trigger_above (clears a too-high condition
        # once back at/under this point); clear_above pairs with
        # trigger_below (clears a too-low condition once back at/over this
        # point) -- "trigger_above=60, clear_below=55" reads as "alarms above
        # 60, clears below 55". Each defaults to its own trigger value (no
        # hysteresis gap) unless given explicitly.
        self.clear_below = clear_below if clear_below is not None else trigger_above
        self.clear_above = clear_above if clear_above is not None else trigger_below
        self.cooldown_seconds = cooldown_seconds
        self.action = action
        self.triggered = False
        self.last_action_at = None  # None, never a numeric sentinel: now==0 must not look like a real prior action

    def evaluate(self, value, now):
        """Returns True exactly when the action worker should be notified."""
        if value is None:
            return False
        if not self.triggered:
            crossed = (self.trigger_above is not None and value > self.trigger_above) or \
                      (self.trigger_below is not None and value < self.trigger_below)
            if not crossed:
                return False
            self.triggered = True
        else:
            # Already triggered: no repeated action while it stays crossed --
            # that's what actually prevents alert spam for a sustained
            # condition, independent of cooldown below. A dual-sided "safe
            # band" rule (both trigger_above and trigger_below configured)
            # only clears once back inside the band on both sides; a
            # single-sided rule clears on its own bound alone. No action
            # fires on clearing itself.
            if self.trigger_above is not None and self.trigger_below is not None:
                cleared = value <= self.clear_below and value >= self.clear_above
            elif self.trigger_above is not None:
                cleared = value <= self.clear_below
            else:
                cleared = value >= self.clear_above
            if cleared:
                self.triggered = False
            return False
        if self.last_action_at is not None and now - self.last_action_at < self.cooldown_seconds:
            return False
        self.last_action_at = now
        return True


class ActionWorker:
    """Runs triggered actions off the sampling thread. A slow/hung action
    delays only further actions, never any sensor's sampling loop."""

    def __init__(self):
        self._queue = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def submit(self, action_name, context):
        self._queue.put((action_name, context))

    def stop(self):
        self._queue.put(None)
        self._thread.join(timeout=10)

    def _run(self):
        while True:
            item = self._queue.get()
            if item is None:
                return
            action_name, context = item
            try:
                ACTIONS[action_name](context)
            except Exception:
                LOG.exception("action %s failed", action_name)


# --------------------------------------------------------------------------
# Durable per-(sensor_type, sensor_id) batch buffer.
# --------------------------------------------------------------------------
class SensorBatcher:
    def __init__(self, sync_queue, sensor_type, sensor_id, flush_seconds, min_free_bytes):
        if not SAFE_LABEL.match(sensor_type) or not SAFE_LABEL.match(sensor_id):
            raise ConfigError("sensor_type/sensor_id must be safe for a storage path segment")
        self.sync_queue = sync_queue
        self.sensor_type = sensor_type
        self.sensor_id = sensor_id
        self.flush_seconds = flush_seconds
        self.min_free_bytes = min_free_bytes
        self.root = Path(sync_queue.config["spool_dir"]) / "sensor_batches" / sensor_type / sensor_id
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.data_path = self.root / "current.ndjson"
        self.meta_path = self.root / "current.meta.json"
        self.count = 0
        self.batch_start = None
        # Guards data_path/meta_path/batch_start/count against the one real
        # race: this sensor's own thread calling append() concurrently with
        # the main thread's flush_if_due()/close(). It is NOT what makes
        # sync_queue safe to touch from here -- see the note on _finalize.
        self._lock = threading.Lock()
        self._recover()

    def _recover(self):
        """A batch in progress when the process last stopped is neither lost
        nor silently merged across a day/flush boundary: resume it if it's
        still current, finalize it immediately if it's stale."""
        if not self.meta_path.is_file():
            if self.data_path.exists():
                self.data_path.unlink()  # orphaned data with no meta: nothing was ever committed to it
            return
        try:
            meta = json.loads(self.meta_path.read_text())
            # Match sync.py's own defensive parsing (validate_capture): don't
            # assume this interpreter's fromisoformat() accepts a bare "Z".
            batch_start = datetime.fromisoformat(meta["batch_start"].replace("Z", "+00:00"))
        except (OSError, ValueError, KeyError):
            LOG.warning("%s/%s: unreadable batch metadata; starting fresh", self.sensor_type, self.sensor_id)
            self.meta_path.unlink(missing_ok=True)
            self.data_path.unlink(missing_ok=True)
            return
        if not self.data_path.is_file() or self.data_path.stat().st_size == 0:
            self.meta_path.unlink(missing_ok=True)
            self.data_path.unlink(missing_ok=True)
            return
        now = utcnow()
        if self._due(batch_start, now, self.data_path.stat().st_size):
            LOG.info("%s/%s: finalizing stale batch left from before restart", self.sensor_type, self.sensor_id)
            with self._lock:  # no real concurrency yet (runs in __init__, before any thread starts) -- consistent anyway
                self._finalize(batch_start)
        else:
            self.batch_start = batch_start
            with self.data_path.open("rb") as stream:
                self.count = sum(1 for _ in stream)

    def _due(self, batch_start, now, size_bytes):
        return (now - batch_start).total_seconds() >= self.flush_seconds or \
            now.date() != batch_start.date() or self.count >= MAX_BATCH_READINGS or size_bytes >= MAX_BATCH_BYTES

    def _begin(self, now):
        # Round-trip through the same serialization recovery will read back,
        # so an in-memory batch_start and a recovered one are always the same
        # value bit-for-bit, never subtly different by sub-millisecond dust.
        now = datetime.fromisoformat(iso(now).replace("Z", "+00:00"))
        atomic_json(self.meta_path, {"batch_start": iso(now)})
        self.batch_start = now
        self.count = 0

    def append(self, reading_dict):
        # Runs on this sensor's own thread. Deliberately never finalizes --
        # sync_queue's SQLite connection was created on the main thread, and
        # Python's sqlite3 module rejects any use from another thread outright.
        # An overdue batch just waits (at most ~1s, the main loop's poll
        # interval) for flush_if_due() to actually finalize it there instead.
        with self._lock:
            now = utcnow()
            if self.batch_start is None:
                if shutil.disk_usage(self.root).free < self.min_free_bytes:
                    LOG.error("%s/%s: local storage below the configured free-space floor; reading dropped",
                              self.sensor_type, self.sensor_id)
                    return
                self._begin(now)
            line = (json.dumps(reading_dict, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
            with open(self.data_path, "ab") as stream:
                stream.write(line)
                stream.flush()
                os.fsync(stream.fileno())
            self.count += 1

    def _finalize(self, batch_start):
        # Callers MUST already hold self._lock AND be running on the same
        # thread that created sync_queue (main()'s thread) -- this touches
        # sync_queue.reserve/finalize/lock, all backed by a sqlite3
        # connection Python refuses to use from a second thread.
        size = self.data_path.stat().st_size if self.data_path.exists() else 0
        self.batch_start = None
        if size == 0:
            self.meta_path.unlink(missing_ok=True)
            return
        # Never trust self.count for the record: it's reset at process start
        # and only reconstructed on a *resumed* recovery, not a *stale,
        # finalize-immediately* one -- the file on disk is the only value
        # that's always right, whichever path got here.
        with self.data_path.open("rb") as stream:
            reading_count = sum(1 for _ in stream)
        try:
            with self.sync_queue.lock("capture"):
                capture_id, folder = self.sync_queue.reserve(expected_bytes=size)
                os.replace(self.data_path, folder / "data")
                sync_directory(folder)
                self.sync_queue.finalize(capture_id, folder, iso(batch_start), kind="sensor",
                                          content_type="application/x-ndjson",
                                          metadata={"format_version": SCHEMA_VERSION, "sensor_type": self.sensor_type,
                                                    "sensor_id": self.sensor_id, "reading_count": reading_count})
        except SyncError as exc:  # QueueFull is-a SyncError; a busy capture.lock is the expected common case
            # Data is untouched on disk; the next due check (moments later)
            # retries. A concurrent video recording holding capture.lock is
            # the expected case here, not a failure worth losing data over.
            LOG.info("%s/%s: batch finalize deferred (%s); will retry", self.sensor_type, self.sensor_id, exc)
            self.batch_start = batch_start
            return
        self.meta_path.unlink(missing_ok=True)
        LOG.info("%s/%s: batch queued (%d readings, %d bytes)", self.sensor_type, self.sensor_id, reading_count, size)

    def flush_if_due(self):
        """Call only from the main thread (sync_queue's thread) -- see _finalize."""
        with self._lock:
            if self.batch_start is not None and self._due(self.batch_start, utcnow(), self.data_path.stat().st_size):
                self._finalize(self.batch_start)

    def close(self):
        """Best-effort flush on clean shutdown; a crash leaves a recoverable
        batch. Call only from the main thread, after every sensor thread that
        could call append() has already been joined -- see _finalize."""
        with self._lock:
            if self.batch_start is not None:
                self._finalize(self.batch_start)


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
def load_sensors_config(path):
    try:
        with open(path, encoding="utf-8") as stream:
            config = json.load(stream)
    except (OSError, ValueError, UnicodeError):
        raise ConfigError("cannot read sensors configuration") from None
    if not isinstance(config, dict) or config.keys() - {"flush_seconds", "sensors"}:
        raise ConfigError("invalid sensors configuration fields")
    flush_seconds = config.setdefault("flush_seconds", 300)
    if type(flush_seconds) is not int or not 30 <= flush_seconds <= 3600:
        raise ConfigError("flush_seconds must be an integer between 30 and 3600")
    sensors = config.get("sensors", [])
    if not isinstance(sensors, list):
        raise ConfigError("sensors must be a list")
    seen = set()
    for entry in sensors:
        if not isinstance(entry, dict) or not isinstance(entry.get("driver"), str) or \
                not isinstance(entry.get("sensor_id"), str) or not SAFE_LABEL.match(entry["sensor_id"]):
            raise ConfigError("each sensor needs a driver name and a safe sensor_id")
        interval = entry.get("sample_interval_seconds", 5)
        if type(interval) not in (int, float) or not 0.1 <= interval <= 3600:
            raise ConfigError("sample_interval_seconds must be between 0.1 and 3600")
        key = (entry["driver"], entry["sensor_id"])
        if key in seen:
            raise ConfigError(f"duplicate sensor_id for driver {entry['driver']}: {entry['sensor_id']}")
        seen.add(key)
        for rule in entry.get("rules", []):
            if not isinstance(rule, dict) or not isinstance(rule.get("field"), str):
                raise ConfigError("each rule needs a field")
    config["sensors"] = sensors
    return config


def build_rules(rule_specs):
    return [Rule(field=r["field"], trigger_above=r.get("trigger_above"), trigger_below=r.get("trigger_below"),
                 clear_above=r.get("clear_above"), clear_below=r.get("clear_below"),
                 cooldown_seconds=r.get("cooldown_seconds", 60), action=r.get("action", "log_alert"))
            for r in rule_specs]


def load_driver_modules(extra_modules):
    for name in extra_modules:
        importlib.import_module(name)
    try:
        importlib.import_module("sensor_drivers.dht11")
    except ImportError:
        LOG.info("dht11 driver unavailable (its dependencies are not installed); continuing without it")


# --------------------------------------------------------------------------
# Per-sensor sampling loop -- one thread each, so one slow sensor/action
# never delays another sensor's sampling.
# --------------------------------------------------------------------------
def run_sensor(driver, sensor_type, sensor_id, interval, rules, batcher, worker, stop):
    while not stop.is_set():
        started = time.monotonic()
        now = utcnow()
        try:
            result = driver.read()
            reading = {"schema_version": SCHEMA_VERSION, "reading_id": str(uuid.uuid4()), "ts": iso(now),
                       "sensor_type": sensor_type, "sensor_id": sensor_id, "status": "ok",
                       "values": result.get("values", {}), "units": result.get("units", {}), "error": None}
        except Exception as exc:  # a faulty sensor must never crash the daemon or block other sensors
            reading = {"schema_version": SCHEMA_VERSION, "reading_id": str(uuid.uuid4()), "ts": iso(now),
                       "sensor_type": sensor_type, "sensor_id": sensor_id, "status": "error",
                       "values": {}, "units": {}, "error": str(exc)[:300]}
            LOG.warning("%s/%s: read failed: %s", sensor_type, sensor_id, exc)
        for rule in rules:
            value = reading["values"].get(rule.field)
            if reading["status"] == "ok" and rule.evaluate(value, time.monotonic()):
                worker.submit(rule.action, {"sensor_type": sensor_type, "sensor_id": sensor_id,
                                             "field": rule.field, "value": value, "reading": reading})
        try:
            batcher.append(reading)
        except Exception:
            # Broad on purpose: this loop must survive anything, not just the
            # OSError a full disk or bad permissions would raise -- an
            # unanticipated failure here must never silently end sampling
            # for the rest of the process's life.
            LOG.exception("%s/%s: could not persist reading locally", sensor_type, sensor_id)
        stop.wait(max(0.0, interval - (time.monotonic() - started)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/hardhat/sensors.json")
    parser.add_argument("--sync-config", default="/etc/hardhat/sync.json")
    parser.add_argument("--driver-module", action="append", default=[],
                        help="Additional importable module to register out-of-tree drivers (repeatable)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    os.umask(0o077)
    try:
        sensors_config = load_sensors_config(args.config)
        sync_queue = Queue(load_sync_config(args.sync_config))
    except ConfigError as exc:
        LOG.error("%s", exc)
        return 78

    load_driver_modules(args.driver_module)
    if not sensors_config["sensors"]:
        LOG.info("no sensors configured; idling")

    worker = ActionWorker()
    worker.start()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    batchers, threads, drivers = [], [], []
    try:
        for entry in sensors_config["sensors"]:
            if entry["driver"] not in DRIVERS:
                LOG.error("unknown driver %r for sensor_id %r; skipping", entry["driver"], entry["sensor_id"])
                continue
            driver = DRIVERS[entry["driver"]](entry)
            drivers.append(driver)
            batcher = SensorBatcher(sync_queue, entry["driver"], entry["sensor_id"],
                                     sensors_config["flush_seconds"], sync_queue.config["min_free_bytes"])
            batchers.append(batcher)
            rules = build_rules(entry.get("rules", []))
            thread = threading.Thread(target=run_sensor, args=(driver, entry["driver"], entry["sensor_id"],
                                       entry.get("sample_interval_seconds", 5), rules, batcher, worker, stop), daemon=True)
            threads.append(thread)
            thread.start()
        while not stop.is_set():
            stop.wait(1)
            for batcher in batchers:
                batcher.flush_if_due()
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=15)
        for batcher in batchers:
            batcher.close()
        for driver in drivers:
            try:
                if hasattr(driver, "close"):
                    driver.close()
            except Exception:
                LOG.exception("driver cleanup failed")
        worker.stop()
        sync_queue.close()
    return 0


if __name__ == "__main__":
    # Running this file directly makes it __main__, not a module named
    # "sensors" -- without this, a driver's `import sensors` would make
    # Python re-execute this file as a SECOND, separate module with its own
    # empty DRIVERS/ACTIONS dicts, and every driver registration would
    # silently vanish into a copy main() never looks at. Aliasing sys.modules
    # makes any later `import sensors` (sensor_drivers/dht11.py, --driver-module
    # plugins) resolve to this exact running module instead of re-importing.
    sys.modules.setdefault("sensors", sys.modules["__main__"])
    raise SystemExit(main())
