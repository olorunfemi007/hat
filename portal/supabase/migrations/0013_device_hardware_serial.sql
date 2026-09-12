-- 0013_device_hardware_serial.sql
--
-- Adds a real, server-tracked hardware_serial column, independent of
-- serial_number. Before this migration, provision_devices() only ever
-- recorded whatever string an operator passed as "the serial" -- by
-- default (device-agent/provision_device.py, no --serial flag) this
-- happened to be the Pi's real hardware serial, but nothing enforced that:
-- the same tool's --serial flag explicitly supports passing a distinct
-- human-facing asset tag instead (see device-agent/README.md), in which
-- case the server had NO independent record of the physical device's real
-- identity at all -- only device.json, on the Pi itself, ever knew it
-- (device-agent/heartbeat.py's load_config() compares it against
-- /proc/device-tree/serial-number, but that check is purely local and
-- never transmitted). Confirmed against a real provisioned Pi: the
-- database's serial_number ended up as an invented asset tag
-- ("HH-1DED5-000001") with the real hardware serial sitting only in that
-- one local device.json, which is also exactly the file that leaked into
-- git history for that device -- see the same conversation's git-history
-- remediation. This migration makes the real hardware serial a first-class,
-- required, server-verified fact instead of a client-only, unverified one:
-- provision_devices() now requires it explicitly, and device_heartbeat()
-- verifies it matches on every single heartbeat, not just once, client-side,
-- at install time.

alter table public.devices add column hardware_serial text;

-- Backfill any row that already existed before this migration (dev seed
-- fixtures, ad-hoc test rows, or a hosted project incrementally upgrading
-- from an earlier migration) with a deterministic, validly-shaped
-- placeholder -- there is no real physical hardware behind a pre-existing
-- fixture row to record instead, and leaving these null would either
-- violate the NOT NULL constraint below or (if left nullable instead)
-- silently skip verification for an unbounded, database-dependent set of
-- rows. Every row provision_devices() creates from this point forward gets
-- a real, caller-supplied value rather than this fallback.
update public.devices
set hardware_serial = left(md5(serial_number), 16)
where hardware_serial is null;

alter table public.devices
  alter column hardware_serial set not null,
  add constraint devices_hardware_serial_format_chk
    check (hardware_serial ~ '^[0-9a-f]{16}$');

comment on column public.devices.hardware_serial is
  'The physical Pi''s /proc/device-tree/serial-number value (16 lowercase hex chars) -- independent of serial_number, which may be a distinct human-facing asset tag (see device-agent/README.md). Set once at provision_devices() time and verified server-side on every device_heartbeat() call, not just checked client-side at install time.';

-- Visible to authenticated org members alongside serial_number -- it's an
-- identifier, not a credential (device_identity_hash/claim_code_hash stay
-- excluded from this grant for that exact distinction; see 0002_rls.sql's
-- comment above the original column list).
grant select (hardware_serial) on public.devices to authenticated;

-- ---------------------------------------------------------------------------
-- provision_devices: now requires the real hardware serial per device,
-- parallel to p_serial_numbers by index. The old single-array signature is
-- dropped outright, not left callable as a second overload -- a caller
-- still able to reach the old form would keep producing hardware_serial-
-- less rows, defeating the entire point of this migration.
-- ---------------------------------------------------------------------------
drop function if exists public.provision_devices(text[]);

create or replace function public.provision_devices(
  p_serial_numbers text[],
  p_hardware_serials text[]
)
returns table (
  serial_number text,
  claim_code text,
  device_identity_secret text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_serial text;
  v_hardware text;
  v_claim_code text;
  v_identity_secret text;
  v_i int;
begin
  if p_serial_numbers is null or array_length(p_serial_numbers, 1) is null then
    raise exception 'p_serial_numbers must be a non-empty array' using errcode = '22004';
  end if;
  if p_hardware_serials is null
      or array_length(p_hardware_serials, 1) <> array_length(p_serial_numbers, 1) then
    raise exception 'p_hardware_serials must be the same length as p_serial_numbers' using errcode = '22004';
  end if;

  for v_i in 1 .. array_length(p_serial_numbers, 1) loop
    v_serial := p_serial_numbers[v_i];
    v_hardware := lower(p_hardware_serials[v_i]);
    if v_hardware !~ '^[0-9a-f]{16}$' then
      raise exception 'hardware_serial must be 16 lowercase hexadecimal characters' using errcode = '22004';
    end if;

    -- 20 random bytes -> 40 lowercase hex chars (160 bits of entropy).
    -- Hex rather than base64: no '+', '/', '=' to trip up printed labels,
    -- URL query params, or someone reading a code aloud/typing it in by
    -- hand. Distinct entropy source per secret per call -- claim_code and
    -- device_identity_secret for the same device are never derived from
    -- each other or from the serial number.
    v_claim_code      := encode(extensions.gen_random_bytes(20), 'hex');
    v_identity_secret := encode(extensions.gen_random_bytes(20), 'hex');

    insert into public.devices (serial_number, hardware_serial, claim_code_hash, device_identity_hash)
    values (
      v_serial,
      v_hardware,
      extensions.crypt(v_claim_code, extensions.gen_salt('bf', 12)),
      extensions.crypt(v_identity_secret, extensions.gen_salt('bf', 10))
    );

    serial_number := v_serial;
    claim_code := v_claim_code;
    device_identity_secret := v_identity_secret;
    return next;
  end loop;
end;
$$;

comment on function public.provision_devices(text[], text[]) is
  'Generates+hashes claim_code and device_identity_secret for each given (serial_number, hardware_serial) pair (parallel arrays, same length), inserts unclaimed device rows, and returns the plaintext ONCE. hardware_serial is verified server-side on every device_heartbeat() call afterward -- see this file. Caller (an operator running this via psql/SQL editor/seed script, never the app) is responsible for capturing the plaintext output for label printing/flashing -- it cannot be recovered afterward. service_role-only.';

revoke all on function public.provision_devices(text[], text[]) from public;
grant execute on function public.provision_devices(text[], text[]) to service_role;

-- ---------------------------------------------------------------------------
-- device_heartbeat: now also verifies hardware_serial, folded into the same
-- anti-enumeration posture as every other credential check here (see
-- 0004_heartbeat_function.sql's header) -- a mismatch is treated exactly
-- like a wrong device_identity_secret (zero rows, counts toward the same
-- per-serial throttle), never a distinguishable error, so a caller who
-- already knows a valid device_identity_secret can't use hardware_serial
-- mismatches to probe anything further.
-- ---------------------------------------------------------------------------
drop function if exists public.device_heartbeat(text, text);

create or replace function public.device_heartbeat(
  p_serial_number text,
  p_device_identity_secret text,
  p_hardware_serial text
)
returns table (
  serial_number text,
  status text,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_hash text;
  v_hardware_serial text;
  v_code_ok boolean;
  v_recent_failures int;
  -- Fixed bcrypt-shaped dummy hash (cost 10, matching device_identity_hash's
  -- real cost factor), with no corresponding real secret. Compared against
  -- on every path that doesn't have a real hash to check (nonexistent
  -- serial, or throttled), so those paths pay the identical crypt() cost as
  -- "serial exists, wrong secret" -- see 0004_heartbeat_function.sql's
  -- timing-side-channel note.
  v_dummy_hash constant text := '$2a$10$jVLZEJOjyRtwFOTwqL0dEuJCiZAxBmM9rf5LrgYr5yPGFXFIsvliG';
begin
  if p_serial_number is null or p_device_identity_secret is null or p_hardware_serial is null then
    raise exception 'serial_number, device_identity_secret, and hardware_serial are required' using errcode = '22004';
  end if;

  select count(*) into v_recent_failures
  from public.device_auth_failures f
  where f.serial_number = p_serial_number
    and failed_at > now() - interval '15 minutes';

  if v_recent_failures >= 10 then
    perform extensions.crypt(p_device_identity_secret, v_dummy_hash);
    return;
  end if;

  select d.id, d.device_identity_hash, d.hardware_serial
    into v_id, v_hash, v_hardware_serial
  from public.devices d
  where d.serial_number = p_serial_number;

  if v_hash is null then
    perform extensions.crypt(p_device_identity_secret, v_dummy_hash);
    insert into public.device_auth_failures (serial_number) values (p_serial_number);
    return;
  end if;

  v_code_ok := (v_hash = extensions.crypt(p_device_identity_secret, v_hash));

  -- Both conditions computed before combining, same rule as every other
  -- multi-condition check in this file (see 0004's timing note): a bare
  -- string comparison costs nothing extra either way, but keeping this
  -- check's shape consistent with the rest of the file (rather than relying
  -- on a reader noticing hardware_serial is "just" an identifier and
  -- therefore fine to compare differently) means this file has exactly one
  -- pattern to audit, not two.
  if not v_code_ok or v_hardware_serial <> lower(p_hardware_serial) then
    insert into public.device_auth_failures (serial_number) values (p_serial_number);
    return;
  end if;

  -- Status transition: an unclaimed device that phones home (possible if
  -- it has real connectivity before anyone has claimed it yet) stays
  -- unclaimed -- last_seen_at is still recorded, which is useful
  -- provisioning telemetry, but there is no org to be "active" in. Any
  -- claimed/active/offline device transitions to active: this is
  -- deliberately the only status this function can ever set it to
  -- (offline is decided by absence of heartbeats, see
  -- mark_stale_devices_offline, not asserted by the device itself).
  update public.devices d
  set last_seen_at = now(),
      status = case when d.status = 'unclaimed' then 'unclaimed' else 'active' end
  where d.id = v_id;

  return query
    select d.serial_number, d.status, d.last_seen_at
    from public.devices d
    where d.id = v_id;
end;
$$;

comment on function public.device_heartbeat(text, text, text) is
  'Device phone-home: verifies device_identity_secret against device_identity_hash AND hardware_serial against the row''s recorded value, both server-side, and updates last_seen_at/status for exactly that one row. Granted to anon only -- see 0004_heartbeat_function.sql''s header. Failure (unknown serial, wrong secret, wrong hardware_serial, or throttled) returns zero rows rather than raising, and a hardware_serial mismatch counts toward the same per-serial throttle as a wrong secret.';

revoke all on function public.device_heartbeat(text, text, text) from public;
grant execute on function public.device_heartbeat(text, text, text) to anon, service_role;
