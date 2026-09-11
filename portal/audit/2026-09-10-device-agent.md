# Device identity and heartbeat implementation

Implemented a Python standard-library companion service under `device-agent/`, an operator provisioning/export tool, Pi installation via systemd, and Supabase migration 0012 for scheduled maintenance.

## Behavior

- The operator reads a Pi's hardware serial and provisions a matching database serial and identity secret. An optional asset serial can differ from the hardware serial.
- The private device configuration is checked against the Pi's actual hardware serial. Administrative Supabase keys and claim codes are excluded from the installed device configuration.
- The service sends immediately, then every 60–65 seconds. Transient network errors back off and retry independently of Wi-Fi configuration. Identity rejection backs off beyond the database's 15-minute throttle window.
- Unclaimed devices remain unclaimed on heartbeat; claimed/offline devices become active. The database marks stale active devices offline after ten minutes, on a minute-based schedule.
- The installer preserves existing identities and starts the companion only when a valid configuration is present. Wi-Fi onboarding installs the companion without changing its network-control logic.

## Verification

- 14 Python unit tests passed: hardware mismatch/file permissions, credential restrictions, HTTPS configuration, request headers and redirect refusal, rejected/malformed RPC results, error redaction, bounded response size, retries/recovery, throttle cooldown, private provisioning exports, and no overwrite/retry on ambiguous provisioning outcomes.
- `device-agent/tests/local_integration.py` passed against real local Supabase: provisioning export, unclaimed heartbeat, human claim, transition to active, invalid secret/unknown serial rejection, a fresh CLI process reloading the same identity, timestamp refresh, the actual scheduled offline sweep, and reactivation. Its isolated device, organization, and account were removed.
- All 137 existing database assertions passed. The plain Postgres shim tests migrations through 0011; the actual Supabase integration covers migration 0012/pg_cron.
- Shell syntax checks passed for both installers. Python entry-point help and compilation checks passed.
- Local cron metadata confirms the offline job is enabled every minute and has successful runs. The hourly authentication-log cleanup job is enabled at minute 17.

## Deployment state

Migration 0012 is applied to the running local Supabase database. Hosted databases still need the migration applied through the normal deployment workflow. No physical Pi was accessed or changed in this session; the hardware-serial file was simulated for the off-Pi integration test. The user's existing hardware verification is accepted, but the new systemd service still needs installation on each provisioned Pi.

Follow `device-agent/README.md` for provisioning, secure config transfer, installation, and job/log inspection. Device records update server-side; refresh the current portal page to see new status (no realtime subscription was added).
