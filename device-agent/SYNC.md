# Voice capture → verified company storage

The first release connects the existing camera voice commands to a durable local
queue and direct uploads to AWS S3 or MinIO. It uses the Pi's existing device
identity; **do not provision the device again**. Heartbeat and Wi-Fi onboarding
continue as independent services. Azure/GCS, multipart resume, continuous video,
and analytics webhooks are outside this release.

## Enable on an already-working Pi

Apply the portal's capture-sync migration and configure its server-side storage
credentials first. In the portal, connect and test an S3/MinIO destination, then
assign the hat to that destination's organization/site. The Pi only needs the
portal's public HTTPS address; cloud keys remain on the server.

Copy the updated repository to the Pi, then from its repository root:

```bash
cp device-agent/sync.example.json /tmp/hardhat-sync.json
nano /tmp/hardhat-sync.json
```

Set `portal_url` to the deployed portal origin, for example
`https://portal.yourcompany.com` (no trailing path). Leave the other settings at
their defaults initially. Install the sync agent with that configuration:

```bash
bash device-agent/setup_pi.sh --sync-config /tmp/hardhat-sync.json
```

This preserves `/etc/hardhat/device.json`, installs the sync/capture programs,
creates the private spool, and enables synchronization on boot. The sync service
only starts when both identity and sync configuration are present. No camera is
started by the device-agent installer.

Stop your old foreground/tmux voice listener before enabling the service, so two
processes do not compete for the microphone. Use the **same working ALSA device**
you already use with `kws_listen.py`; `plughw:0,0` below is an example:

```bash
bash voice-trigger/setup_capture_service.sh --alsa-device plughw:0,0
```

This builds the updated Go runner, installs the listener and a Python venv under
`/opt/hardhat/voice-trigger`, installs FFmpeg, and enables `hardhat-voice.service`.
It checks for camera tools and bundled PocketSphinx models before enabling the
service. Keep using your working Pi camera/audio configuration; this installer
does not change GPIO or NetworkManager settings. If you use custom speech models,
put their files under `/opt/hardhat/voice-trigger` and set the listener's
`--hmm`/`--dict` paths in `/etc/hardhat/voice-trigger.env`.

Say **“turn on camera”** to record a new 10-second clip. Say **“turn off camera”**
to finish it early. Repeated camera-on detections leave an in-progress recording
running. Each successfully closed recording becomes a distinct MP4 with a UUID
capture ID and SHA-256 checksum. The final MP4 and manifest reach durable storage
before they enter the upload queue.

Follow both services and inspect the local queue:

```bash
sudo journalctl -u hardhat-voice.service -u hardhat-sync.service -f
sudo -u hardhat-heartbeat python3 -B /opt/hardhat/device-agent/sync.py --status
```

The portal's capture/sync view confirms when storage has verified each object.
A successful PUT alone does not authorize local deletion.

## Test one recording without speech

After installing the voice capture service's dependencies, you can run:

```bash
sudo systemctl stop hardhat-voice.service
sudo -u hardhat-heartbeat python3 -B /opt/hardhat/device-agent/capture.py --duration 10
sudo -u hardhat-heartbeat python3 -B /opt/hardhat/device-agent/sync.py --status
sudo systemctl start hardhat-voice.service
```

Leave `hardhat-sync.service` running to upload it automatically. For a one-shot
uploader test, stop that service first and use `sync.py --once`; it exits nonzero
on a failed due upload or failed status report. The uploader lock prevents two
instances from racing. Do not run capture as root: capture and sync share the
`hardhat-heartbeat` system account, which owns the private queue and has the
camera/audio group memberships.

## Local retention and failure behavior

- The default recording is 1280×720, 30 fps, H.264 at 4 Mbit/s, remuxed to MP4
  without re-encoding. A clip is limited to 64 MiB and 120 seconds; the default is
  10 seconds. Actual Pi camera/encoder support still needs an on-device check.
- The default spool limit is 2 GiB, with at least 256 MiB left free on the SD card.
  Starting a recording reserves 128 MiB of headroom because remuxing briefly
  needs both source and MP4. Partial files and retained verified files count
  against the spool limit. The recorder also watches size/free space while
  recording. If capacity is insufficient, it reports an error and refuses a new
  recording; it never evicts an unverified capture to make room.
- Verified captures remain local for 24 hours by default (`retention_hours`).
  `0` deletes them after a matching verified receipt is committed to SQLite.
  Receipt metadata stays in the local database. Unverified captures are never
  deleted automatically.
- Upload retries use exponential backoff with jitter (about 5 seconds initially,
  at most about 15 minutes). Network failures, expired upload URLs, and reboots
  preserve the queue. This release retries a bounded clip from its beginning;
  **it does not implement multipart/resumable uploads**.
- After a lost completion response, the agent checks completion before uploading
  again. Server reservations and object paths remain stable for the capture ID.
- If power is lost after a completed manifest was written but before the queue
  commit, startup recovers that capture from its manifest. Unfinished, damaged,
  or nonzero-exit camera recordings remain local and are flagged for inspection;
  they are not uploaded as valid captures. Inspect the private
  `/var/lib/hardhat-sync/captures/<capture-id>/` directory to recover or remove
  those files deliberately. There is no automatic repair of a truncated video.
- HTTPS is required, redirects are refused, and only prescribed provider upload
  headers go to storage. Device identity and cloud credentials are never included
  in upload headers. Invalid/mismatched receipts keep the file local.
- `allow_http: true` exists only for trusted local development, including a local
  MinIO/portal fixture. Do not ship it in production configuration. A Pi uses a
  reachable LAN address for that fixture, never the laptop's `localhost`.

## Customize the existing voice hooks

Your `-camera_cmd` override remains supported. To use a custom camera tool **and
still queue its captures**, invoke `capture.py --camera-command` with an argv
string containing `{output}` (and optionally `{duration_ms}`). The wrapper owns
that unique output path. The custom command must close successfully and exit 0;
`--source-format mp4` declares that it already produces a finalized MP4. Otherwise
it must produce H.264 at 30 fps, which the wrapper remuxes. Put commands with
embedded spaces/arguments in an executable wrapper script under `/opt/hardhat`
and point `HARDHAT_CAMERA_CMD` at that script.

A custom `-camera_cmd` that directly writes its own file bypasses the queue, just
as the old bench command did. The default command now uses the durable wrapper
instead of repeatedly overwriting `/home/pi/clip.h264`.

There is **no light hardware driver** in this repository yet. Optional
`-light_on_cmd` and `-light_off_cmd` are separate hooks, empty by default. Once
you have a working light control executable, configure it in
`/etc/hardhat/voice-trigger.env`, add its phrases to the listener keyword list,
and restart the voice service. Light phrases never start the camera. No GPIO
pin or electrical behavior is assumed.

The setup script preserves an existing `voice-trigger.env`. After changing it:

```bash
sudo systemctl restart hardhat-voice.service
```

## Golden images

Install these programs/services and the shared, non-secret `sync.json` before
creating the image. Stop voice/sync before imaging, and exclude captured files
and the source hat's device identity from a distributable image. Keep the
existing per-Pi identity import workflow: provisioning does not repeat on reboot.
The sync unit's conditions wait for the identity/configuration files on boot.

## Validation

From the repository root:

```bash
python3 -m unittest discover -s device-agent/tests -v
bash -n device-agent/setup_pi.sh voice-trigger/setup_capture_service.sh
bash device-agent/tests/test_import_device_json.sh
(cd voice-trigger && go test -race ./...)
```

The queue/upload tests use temporary files and local HTTP fixtures to exercise
crash recovery, retries, integrity checks, expiration, bad receipts, storage
limits and credential/redirect protection. Voice tests exercise separate
camera/light dispatch, repeat-trigger behavior and graceful stop without two
`Wait` calls. These tests do not establish physical microphone/camera behavior
or power-loss durability of a particular SD card/controller.
