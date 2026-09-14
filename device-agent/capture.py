#!/usr/bin/env python3
"""Record a bounded camera clip, finalize it as MP4, then enqueue it durably."""
import argparse
import logging
import os
from pathlib import Path
import shlex
import shutil
import signal
import sqlite3
import subprocess
import threading
import time

from heartbeat import ConfigError
from sync import MAX_CAPTURE_BYTES, Queue, QueueFull, SyncError, load_sync_config, sync_directory, utc_now

LOG = logging.getLogger("hardhat-capture")


def record(queue, duration=10, camera_command=None, source_format="h264", stop=None):
    """An administrator-supplied command is argv, never interpreted by a shell.

    {output} is replaced with a unique private path. A successful process exit
    closes the source; SIGTERM of this wrapper requests SIGINT of the camera so
    supported camera tools can flush a shorter clip on 'turn off camera'.
    """
    if not 1 <= duration <= 120:
        raise SyncError("clip duration must be between 1 and 120 seconds")
    if camera_command:
        args = shlex.split(camera_command)
        if not any("{output}" in arg for arg in args):
            raise SyncError("camera command must include {output}")
    else:
        if source_format != "h264":
            raise SyncError("source-format mp4 requires a custom MP4 camera command")
        binary = shutil.which("rpicam-vid") or shutil.which("libcamera-vid")
        if not binary:
            raise SyncError("rpicam-vid or libcamera-vid is required")
    if source_format == "h264" and not shutil.which("ffmpeg"):
        raise SyncError("ffmpeg is required to finalize MP4 recordings")
    if stop is None:
        stop = threading.Event()
    with queue.lock("capture"):
        # Reserve two object sizes because H.264 -> MP4 remux briefly stores both.
        capture_id, folder = queue.reserve(MAX_CAPTURE_BYTES * 2)
        captured_at = utc_now()
        source = folder / "source.part"
        if camera_command:
            args = [arg.replace("{output}", str(source)).replace("{duration_ms}", str(duration * 1000)) for arg in args]
        else:
            args = [binary, "--nopreview", "--codec", "h264", "--inline", "--width", "1280", "--height", "720",
                    "--framerate", "30", "--bitrate", "4000000", "--timeout", str(duration * 1000), "--output", str(source)]
        LOG.info("recording capture %s", capture_id)
        proc = subprocess.Popen(args, start_new_session=True, stdin=subprocess.DEVNULL)
        deadline = time.monotonic() + duration + 15
        stopping_at = None
        invalid = False
        try:
            while proc.poll() is None:
                if source.exists() and (source.stat().st_size > MAX_CAPTURE_BYTES
                        or shutil.disk_usage(folder).free < queue.config["min_free_bytes"]):
                    invalid = True
                    stop.set()
                now = time.monotonic()
                if (stop.is_set() or now > deadline) and stopping_at is None:
                    stopping_at = now
                    # rpicam/libcamera handles SIGINT and closes its output.
                    os.killpg(proc.pid, signal.SIGINT)
                if stopping_at is not None and now - stopping_at > 10:
                    os.killpg(proc.pid, signal.SIGKILL)
                    invalid = True
                time.sleep(0.1)
            result = proc.wait()
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        if invalid or result != 0:
            queue.set_error("Recording interrupted or storage limit reached; partial capture retained locally")
            raise SyncError("camera did not close successfully; partial file retained and not uploaded")
        if not source.is_file() or source.is_symlink() or not 1 <= source.stat().st_size <= MAX_CAPTURE_BYTES:
            queue.set_error("Camera produced an invalid or oversized recording; inspect spool")
            raise SyncError("camera output is empty, missing or exceeds 64 MiB")
        os.chmod(source, 0o600)
        final_temp = folder / "final.part"
        if source_format == "h264":
            # No re-encoding: produce a broadly compatible MP4 container. Input
            # timestamps come from the fixed 30fps capture mode above.
            try:
                subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-r", "30", "-f", "h264", "-i", str(source), "-c:v", "copy", "-movflags", "+faststart",
                    "-f", "mp4", str(final_temp)], check=True, timeout=60)
            except (subprocess.SubprocessError, OSError):
                queue.set_error("MP4 finalization failed; source recording retained locally")
                raise SyncError("MP4 finalization failed; source retained and not uploaded") from None
        else:
            os.replace(source, final_temp)
        if not 1 <= final_temp.stat().st_size <= MAX_CAPTURE_BYTES:
            raise SyncError("final recording exceeds 64 MiB; retained locally")
        os.replace(final_temp, folder / "data")
        sync_directory(folder)
        manifest = queue.finalize(capture_id, folder, captured_at, metadata={"format_version": 1, "trigger": "voice", "container": "mp4"})
        # Source is merely a temporary second representation, removed ONLY once a
        # finalized durable capture and its queue entry have both been committed.
        if source.exists():
            source.unlink()
            sync_directory(folder)
        LOG.info("capture %s queued (%s bytes)", capture_id, manifest["byte_size"])
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/hardhat/sync.json")
    parser.add_argument("--duration", type=int, default=10, help="Seconds per clip, 1..120 (default 10)")
    parser.add_argument("--camera-command", help="Optional argv string including {output}; also accepts {duration_ms}")
    parser.add_argument("--source-format", choices=("h264", "mp4"), default="h264", help="Output format of custom camera command")
    args = parser.parse_args()
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    queue = None
    try:
        queue = Queue(load_sync_config(args.config))
        record(queue, args.duration, args.camera_command, args.source_format, stop)
        return 0
    except ConfigError as exc:
        LOG.error("%s", exc)
        return 78
    except (SyncError, OSError, ValueError, sqlite3.Error) as exc:
        LOG.error("%s", exc if isinstance(exc, SyncError) else "capture failed; check camera configuration and spool permissions")
        return 1
    finally:
        if queue:
            queue.close()


if __name__ == "__main__":
    raise SystemExit(main())
