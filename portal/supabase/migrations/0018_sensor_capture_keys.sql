-- 0018_sensor_capture_keys.sql
--
-- Gives sensor captures their own intelligent folder structure instead of
-- sharing the flat per-device date folder video/audio/image already use:
--
--   video/audio/image (unchanged): <org>/<device_serial>/YYYY/MM/DD/<capture_id>.<ext>
--   sensor (new):                  <org>/<device_serial>/sensors/<sensor_type>/<sensor_id>/YYYY/MM/DD/<capture_id>.<ext>
--
-- sensor_type/sensor_id come from the capture's own metadata (the device
-- tags every sensor batch with them) and are validated with the same
-- safe-path-segment rule 0017 already applies to device_serial_number: no
-- '/', no control characters, must start with something safe. A kind='sensor'
-- capture without a safe sensor_type/sensor_id is rejected outright rather
-- than silently falling into some generic location -- an unclassified
-- sensor reading is exactly the flat-folder problem this migration exists
-- to fix.
--
-- This lets any new sensor type get its own folder automatically: the
-- device just tags readings with a new sensor_type string, no further
-- migration required.
--
-- video/audio/image keys are completely unaffected: the case expression
-- below contributes nothing to their path when kind <> 'sensor', so they
-- get byte-for-byte the same key 0017 already produces. Existing captures
-- (any kind) keep whatever key they were already assigned -- reserve_capture
-- only ever builds v_key on first reservation for a capture_id.
create or replace function public.reserve_capture(
  p_device_id uuid, p_capture_id uuid, p_captured_at timestamptz,
  p_kind text, p_content_type text, p_byte_size bigint, p_sha256 text,
  p_metadata jsonb default '{}'::jsonb
)
returns setof public.captures language plpgsql security definer set search_path = '' as $$
declare
  v_device public.devices%rowtype;
  v_capture public.captures%rowtype;
  v_config public.storage_configs%rowtype;
  v_site_storage uuid;
  v_key text;
begin
  if p_capture_id is null or p_captured_at is null or not isfinite(p_captured_at)
      or p_captured_at < '1970-01-01'::timestamptz or p_captured_at > now() + interval '1 day'
      or p_kind is null or p_content_type is null or p_byte_size is null
      or p_sha256 is null or p_metadata is null then
    raise exception 'invalid capture manifest' using errcode = '22023';
  end if;
  select * into v_device from public.devices where id = p_device_id for share;
  if not found or v_device.org_id is null or v_device.status = 'unclaimed' or v_device.upload_revoked_at is not null then
    raise exception 'device uploads are not authorized' using errcode = '42501';
  end if;
  -- Serializes retries with the same ID even across different devices. A UUID
  -- is never authority: the owner and every manifest field must still match.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_capture_id::text, 14));
  select * into v_capture from public.captures where capture_id = p_capture_id for update;
  if found then
    if row(v_capture.device_id, v_capture.org_id, v_capture.captured_at, v_capture.kind,
           v_capture.content_type, v_capture.byte_size, v_capture.sha256, v_capture.metadata)
      is distinct from row(p_device_id, v_device.org_id, p_captured_at, p_kind,
           p_content_type, p_byte_size, p_sha256, p_metadata) then
      raise exception 'capture id is already reserved with a different device or manifest' using errcode = '23505';
    end if;
    -- A verified receipt remains an honest historical result even if storage
    -- has since been disabled. No further upload authority is issued for it.
    if v_capture.status <> 'verified' then
      perform 1 from public.storage_configs where id = v_capture.storage_config_id and org_id = v_device.org_id
        and disabled_at is null and verified_at is not null for share;
      if not found then raise exception 'pinned storage destination is unavailable' using errcode = '55000'; end if;
    end if;
    return next v_capture;
    return;
  end if;
  perform 1 from public.organizations where id = v_device.org_id for share;
  if v_device.site_id is not null then
    select s.storage_config_id into v_site_storage from public.sites s
      where s.id = v_device.site_id and s.org_id = v_device.org_id for share;
  end if;
  select * into v_config from public.storage_configs s where s.org_id = v_device.org_id
    and (case when v_site_storage is not null then s.id = v_site_storage else s.is_default end)
    and s.disabled_at is null and s.verified_at is not null and s.provider in ('s3', 'minio') for share;
  if not found then raise exception 'no verified storage destination is configured' using errcode = '55000'; end if;
  -- serial_number has no format constraint at the table level (provision_devices
  -- accepts any operator-supplied text) and was never previously embedded in
  -- anything path- or security-relevant -- this is the first place that
  -- changes, so the safety check belongs here rather than as a retroactive
  -- constraint on every already-provisioned device. No '/' (would silently
  -- add path segments the rest of this function doesn't expect), no control
  -- characters, must start with something safe.
  if v_device.serial_number !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' then
    raise exception 'device serial number is not safe for use in a storage object key' using errcode = '22023';
  end if;
  if p_kind = 'sensor' and (
      p_metadata->>'sensor_type' is null or p_metadata->>'sensor_type' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' or
      p_metadata->>'sensor_id' is null or p_metadata->>'sensor_id' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') then
    raise exception 'sensor captures require a safe sensor_type and sensor_id in metadata' using errcode = '22023';
  end if;
  v_key := v_device.org_id::text || '/' || v_device.serial_number || '/'
    || case when p_kind = 'sensor'
         then 'sensors/' || (p_metadata->>'sensor_type') || '/' || (p_metadata->>'sensor_id') || '/'
         else '' end
    || to_char(p_captured_at at time zone 'UTC', 'YYYY/MM/DD') || '/' || p_capture_id::text
    || case p_content_type
      when 'video/mp4' then '.mp4' when 'video/h264' then '.h264'
      when 'video/x-matroska' then '.mkv' when 'video/webm' then '.webm'
      when 'audio/wav' then '.wav' when 'audio/x-wav' then '.wav'
      when 'audio/mpeg' then '.mp3' when 'audio/mp4' then '.m4a'
      when 'audio/ogg' then '.ogg' when 'audio/flac' then '.flac'
      when 'image/jpeg' then '.jpg' when 'image/png' then '.png'
      when 'application/json' then '.json' when 'application/x-ndjson' then '.ndjson'
      when 'text/csv' then '.csv' else '' end;
  insert into public.captures (capture_id, org_id, device_id, site_id, storage_config_id,
    object_key, kind, content_type, byte_size, sha256, metadata, captured_at)
  values (p_capture_id, v_device.org_id, p_device_id, v_device.site_id, v_config.id,
    v_key, p_kind, p_content_type, p_byte_size, p_sha256, p_metadata, p_captured_at)
  returning * into v_capture;
  return next v_capture;
end;
$$;

comment on function public.reserve_capture(uuid, uuid, timestamptz, text, text, bigint, text, jsonb) is
  'Idempotently reserves (or returns the existing reservation for) one capture, assigning its object_key on first reservation only. video/audio/image: <org_id>/<device_serial>/YYYY/MM/DD/<capture_id>.<ext> (0017). sensor: <org_id>/<device_serial>/sensors/<sensor_type>/<sensor_id>/YYYY/MM/DD/<capture_id>.<ext> (0018), where sensor_type/sensor_id come from metadata and must pass the same safe-path-segment check as device_serial_number -- a sensor capture without them is rejected, never silently placed in a generic location. Existing captures keep whatever key they were already assigned.';
