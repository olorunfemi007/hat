# Pi identity and heartbeat

This service closes the loop between a physical Pi, Wi-Fi onboarding, and the portal. It uses Python 3's standard library and runs independently of the Wi-Fi watcher. It starts on boot, sends an immediate heartbeat, then repeats every 60–65 seconds. Network failures retry after 5, 10, 20, 40, then at most 65 seconds; recovery needs no reboot. A portal outage never changes the Pi's Wi-Fi configuration.

## Provision one physical Pi

Use a trusted operator workstation with access to the Supabase secret/service-role key. Do not put that key on the Pi or in a label. Each Pi needs its own export; do not clone an already-provisioned SD image across devices.

1. Read the actual hardware serial on the Pi:

   ```bash
   tr -d '\000\n' < /proc/device-tree/serial-number
   ```

2. On the operator workstation, run this from the repository root, replacing the example serial and URLs. The command prompts privately for the administrative key (or reads `SUPABASE_SERVICE_ROLE_KEY` from the operator's environment):

   ```bash
   python3 device-agent/provision_device.py \
     --hardware-serial 000000001234abcd \
     --supabase-url https://YOUR-PROJECT.supabase.co \
     --publishable-key sb_publishable_YOUR_PROJECT_KEY \
     --portal-url https://YOUR-PORTAL.example.com \
     --output-dir /secure/operator/exports/pi-000000001234abcd
   ```

   The output directory must be new, and its parent must exist. By default the database serial is the hardware serial. For an existing asset-number scheme, add `--serial HAT-000123`; the separate hardware serial still binds the config to that physical Pi.

   The tool calls `provision_devices` once and creates a private directory (0700) containing files with mode 0600:

   - `device.json`: serial, expected Pi hardware serial, identity secret, Supabase URL, and public API key. This is the only file to install on the Pi.
   - `claim-label.txt`: serial, human claim code, and a claim URL. Print it on the device or encode the URL as your label's QR code. It contains no device identity secret.
   - `provisioning-result.json`: private recovery export of the once-returned credentials. Keep it in secure operator storage, separate from printed labels and source control.

   The command refuses to overwrite an export or retry a failed request automatically. If it leaves `INCOMPLETE.txt`, inspect the export and database first: a timeout may have occurred after the database committed. Never invent a new secret locally for an existing row. Lost credentials require an operator-controlled reprovisioning/rotation procedure; this tool does not rotate existing devices.

3. Transfer only `device.json` securely to its matching Pi, preserve mode 0600, and run on the Pi:

   ```bash
   chmod 600 /path/to/device.json
   bash device-agent/setup_pi.sh --config /path/to/device.json
   ```

   Installation checks the real hardware serial before accepting the file, installs the config at `/etc/hardhat/device.json` (0600, owned by the dedicated `hardhat-heartbeat` system user the installer creates -- not root; the service runs as that user directly rather than `DynamicUser=yes`+`LoadCredential=`, see `hardhat-heartbeat.service`'s header for why), and starts/enables `hardhat-heartbeat.service`. It refuses to replace a different existing identity. After verifying installation, remove the staging copy through your normal credential-handling process.

   `wifi-onboarding/setup_pi.sh` also installs this companion service, but it stays inactive until a device config exists. You can install/configure the companion separately without changing working Wi-Fi setup.

## Zero-touch provisioning (golden image + per-unit device.json at flash time)

The manual flow above (SSH in, transfer `device.json`, run `setup_pi.sh --config`) doesn't scale past a handful of units. For a batch, prepare one golden image once -- run `setup_pi.sh` on it with **no** `--config` (installs the agent, both services enabled, both correctly inactive since `/etc/hardhat/device.json` doesn't exist yet) -- then, per unit:

1. Flash the identical golden image to that unit's SD card.
2. Provision that specific unit (`provision_device.py --hardware-serial <that unit's real serial> ...`, per "Provision one physical Pi" above), producing its own `device.json`.
3. Before first boot, drop that `device.json` onto the card's boot partition -- the FAT32 partition every OS can mount and write to directly, no special tooling needed (the same partition Raspberry Pi OS already uses for headless Wi-Fi/SSH setup tricks like `wpa_supplicant.conf`):
   ```bash
   cp device.json /Volumes/bootfs/device.json   # macOS; the boot partition's mount point/label can vary by imaging tool and Raspberry Pi OS version -- check what actually appears after flashing
   ```
4. Boot the unit. `hardhat-device-import.service` (installed and enabled by `setup_pi.sh`, ordered `Before=hardhat-heartbeat.service`) runs `import-device-json.sh` automatically, before the heartbeat service ever starts:
   - No file on the boot partition -- no-op (this is what every *subsequent* boot looks like, and what a unit provisioned the manual way looks like too).
   - A valid file, matching this unit's actual hardware serial, and no identity already installed -- installs it as `/etc/hardhat/device.json` with the same ownership/permissions `setup_pi.sh --config` would set, then deletes it from the boot partition (that FAT32 copy has no Unix permissions at all -- readable by anyone with the card in a reader for as long as it sits there, so it's removed as soon as it's been copied somewhere that isn't).
   - A file that fails validation, or one whose hardware serial doesn't match this specific unit (e.g. the wrong card ended up in the wrong unit during batch assembly), or an `/etc/hardhat/device.json` that already exists and differs -- refuses, renames the boot-partition file to `device.json.rejected` (left in place, for a technician to pull the card and inspect what shipped in that slot) rather than either silently discarding it or overwriting a working identity.
   `hardhat-heartbeat.service` then starts normally on this and every later boot, exactly as if `setup_pi.sh --config` had been run directly.

`import-device-json.sh` reuses `heartbeat.py`'s own config validation (schema shape and the hardware-serial pairing check) rather than reimplementing it -- one place this has to be correct, same rule as everywhere else in this project. Every path it uses is overridable via environment variable (see the script's own header) for testing without real hardware; `device-agent/tests/test_import_device_json.sh` exercises it end to end (no boot-partition file, a valid one, an already-installed identical/different identity, and a wrong-hardware-serial file) without sudo or a real Pi.

## What becomes active, and when

```text
Provisioning                         unclaimed
Valid heartbeat before claim         unclaimed, last_seen_at updated
Customer claims serial + claim code  claimed, organization attached
Next valid device heartbeat          active
No heartbeat for >10 minutes         offline at the next minute sweep
Next valid heartbeat                 active again
```

Online discovery does not establish ownership. The public/anon key identifies the project; the serial plus device identity secret authenticates the individual Pi. The agent never receives organization/admin credentials. A copied configuration is rejected locally when the hardware serial in `device.json` doesn't match the Pi it's running on, and separately rejected by the server on every heartbeat if the hardware serial doesn't match what `provision_devices()` recorded for that serial number (`0013_device_hardware_serial.sql`) -- the local check alone was insufficient in practice: a `device.json` copied off a Pi and used from anywhere else used to authenticate fine as long as `device_identity_secret` matched, since only the client checked hardware_serial at all. Neither check is tamper-proof hardware attestation against someone with root access on the source Pi.

The agent uses HTTPS and refuses redirects to avoid handing the credential to a captive portal. Opaque publishable keys go in `apikey`; legacy anon JWT keys also use `Authorization`. HTTP is available only with the explicit `--allow-http` provisioning flag for trusted local development. For a Pi testing against your laptop, use the laptop's reachable LAN URL, not `localhost` (which would point to the Pi). Never ship HTTP-enabled configuration.

The systemd service runs as a fixed, unprivileged system user (`hardhat-heartbeat`, created by `setup_pi.sh`) that directly owns `/etc/hardhat/device.json` (mode 0600). An earlier version used `DynamicUser=yes` with `LoadCredential=` instead; that combination was never actually run on real Pi hardware before shipping, and on real hardware it left the service unable to start (`heartbeat.py` rejected its own staged config as insufficiently private, regardless of `/etc/hardhat/device.json`'s own permissions). `setup_pi.sh` now verifies real access at install time by running the config check as `hardhat-heartbeat` itself, not root, so a permission problem is caught immediately rather than only surfacing as a failed service start. Logs report status/retry reasons without printing keys, claim codes, identity secrets, or upstream response bodies. Rejected credentials (including HTTP 200 with an empty RPC result) back off for over 15 minutes to respect the database throttle window. Correct the provisioning/config and restart the service after an identity rejection.

## Install the server schedule

Apply all Supabase migrations through `0013_device_hardware_serial.sql` using your normal migration workflow. For a database that already has migrations 0001–0011, apply 0012 and 0013. Migration 0012 enables `pg_cron` and creates two named jobs:

- `hardhat-device-offline`: every minute; marks active devices offline when `last_seen_at` is older than ten minutes. Detection therefore takes roughly 10–11 minutes.
- `hardhat-device-auth-cleanup`: hourly at minute 17; removes authentication-failure records older than 24 hours.

Job names make reapplication update the schedules rather than duplicate them. The jobs run inside Postgres and need no keys on the Pi. This migration requires Supabase's `pg_cron` support; plain Postgres installations must install/preload that extension first. The Docker-only RLS shim suite deliberately covers migrations 0001–0011; the real-stack test below covers the platform schedule.

Inspect the jobs and recent runs in the Supabase SQL editor:

```sql
select jobname, schedule, active from cron.job
where jobname in ('hardhat-device-offline', 'hardhat-device-auth-cleanup');

select j.jobname, r.status, r.start_time, r.return_message
from cron.job_run_details r join cron.job j using (jobid)
where j.jobname like 'hardhat-device-%'
order by r.start_time desc limit 20;
```

[Supabase Cron documentation](https://supabase.com/docs/guides/cron/quickstart) and [API key headers](https://supabase.com/docs/guides/getting-started/api-keys).

## Check operation

On the Pi:

```bash
sudo systemctl status hardhat-heartbeat.service
sudo journalctl -u hardhat-heartbeat.service -f
# Run as hardhat-heartbeat, not root -- root can read the config file
# regardless of its ownership, so checking as root can pass even when the
# service (which runs as hardhat-heartbeat) would fail to start.
sudo -u hardhat-heartbeat python3 -B /opt/hardhat/device-agent/heartbeat.py --check-config
sudo -u hardhat-heartbeat python3 -B /opt/hardhat/device-agent/heartbeat.py --once
```

After claiming, refresh the portal's Devices page to see the next heartbeat reflected. The current portal does not subscribe to live status updates.

## Tests

From the repository root:

```bash
python3 -m unittest discover -s device-agent/tests -v
bash -n device-agent/setup_pi.sh wifi-onboarding/setup_pi.sh device-agent/import-device-json.sh
bash device-agent/tests/test_import_device_json.sh
```

With local Supabase running, migrations applied through 0013, and `portal/.env.local` configured:

```bash
python3 device-agent/tests/local_integration.py
```

The integration test refuses non-local Supabase URLs. It uses temporary exports and isolated device/user/org records, exercises the real provisioning and heartbeat HTTP requests and a fresh CLI process, waits for the actual scheduled offline job (up to 80 seconds), checks reactivation, and removes its records. A simulated hardware-serial file lets this run off-Pi; the installed service always reads the real Pi serial. The existing RLS test suite remains under `portal/supabase/local-test/`.
