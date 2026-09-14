-- Durable capture receipts and tenant-scoped storage routing. Browser users
-- never authenticate a device or assert that an object has been delivered.
-- All upload RPCs are service_role-only; the API verifies the provider object
-- before calling verify_capture_receipt. Existing claim/heartbeat behavior is
-- deliberately independent of upload revocation and upload auth throttling.

alter table public.storage_configs
  add column name text,
  add column is_default boolean not null default false,
  add column verified_at timestamptz,
  add column verification_error text,
  add column disabled_at timestamptz,
  add constraint storage_configs_id_org_uk unique (id, org_id),
  add constraint storage_configs_default_verified_chk check (
    not is_default or (verified_at is not null and disabled_at is null and provider in ('s3', 'minio'))
  );
-- A new destination version can use the same bucket with another endpoint or
-- secret reference. Its UUID, rather than its bucket name, is its identity.
alter table public.storage_configs drop constraint storage_configs_org_provider_bucket_uk;
create unique index storage_configs_default_org_uk
  on public.storage_configs (org_id) where is_default and disabled_at is null;

alter table public.sites add column storage_config_id uuid;
alter table public.sites add constraint sites_storage_org_fk
  foreign key (storage_config_id, org_id) references public.storage_configs (id, org_id) on delete restrict;
alter table public.devices add column upload_revoked_at timestamptz;
alter table public.devices add constraint devices_id_org_uk unique (id, org_id);
grant select (upload_revoked_at) on public.devices to authenticated;

-- Table grants cover newly added columns too. Narrow them before exposing
-- verification results, defaults or site overrides; those need trusted logic.
revoke insert, update on public.storage_configs from authenticated;
grant insert (id, org_id, provider, bucket, region, endpoint, credentials_secret_ref, created_at, name)
  on public.storage_configs to authenticated;
grant update (id, org_id, provider, bucket, region, endpoint, credentials_secret_ref, created_at, name)
  on public.storage_configs to authenticated;
revoke insert, update on public.sites from authenticated;
grant insert (id, org_id, name, address, created_at) on public.sites to authenticated;
grant update (id, org_id, name, address, created_at) on public.sites to authenticated;

create table public.captures (
  capture_id uuid primary key,
  org_id uuid not null references public.organizations (id) on delete restrict,
  device_id uuid not null,
  site_id uuid references public.sites (id) on delete set null,
  storage_config_id uuid not null,
  object_key text not null,
  kind text not null check (kind in ('video', 'audio', 'image', 'sensor')),
  content_type text not null,
  byte_size bigint not null check (byte_size between 1 and 67108864),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8192),
  captured_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'uploading', 'verified', 'needs_attention')),
  attempts bigint not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  provider_version text,
  constraint captures_device_org_fk foreign key (device_id, org_id)
    references public.devices (id, org_id) on delete restrict,
  constraint captures_storage_org_fk foreign key (storage_config_id, org_id)
    references public.storage_configs (id, org_id) on delete restrict,
  constraint captures_object_uk unique (storage_config_id, object_key),
  constraint captures_verified_chk check ((status = 'verified') = (verified_at is not null)),
  constraint captures_content_kind_chk check (
    (kind = 'video' and content_type in ('video/mp4', 'video/h264', 'video/x-matroska', 'video/webm')) or
    (kind = 'audio' and content_type in ('audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac')) or
    (kind = 'image' and content_type in ('image/jpeg', 'image/png')) or
    (kind = 'sensor' and content_type in ('application/json', 'application/x-ndjson', 'text/csv'))
  )
);
create index captures_org_created_idx on public.captures (org_id, created_at desc);
create index captures_device_created_idx on public.captures (device_id, created_at desc);
create index captures_storage_idx on public.captures (storage_config_id);

create table public.device_sync_status (
  device_id uuid primary key,
  org_id uuid not null,
  queued_count bigint not null default 0 check (queued_count between 0 and 1000000),
  queued_bytes bigint not null default 0 check (queued_bytes between 0 and 1099511627776),
  last_contact_at timestamptz not null default now(),
  last_verified_at timestamptz,
  last_error text check (octet_length(last_error) <= 1024),
  foreign key (device_id, org_id) references public.devices (id, org_id) on delete cascade
);

-- At most one throttle row per real device, so invented serial numbers cannot
-- grow this table. A failed upload login never disables the heartbeat path.
create table public.upload_auth_failures (
  device_id uuid primary key references public.devices (id) on delete cascade,
  window_started_at timestamptz not null default now(),
  failures integer not null default 1 check (failures between 1 and 10)
);

alter table public.captures enable row level security;
alter table public.device_sync_status enable row level security;
alter table public.upload_auth_failures enable row level security;
revoke all on public.captures, public.device_sync_status, public.upload_auth_failures from public, anon, authenticated;
grant select on public.captures, public.device_sync_status to authenticated;
grant select, insert, update, delete on public.captures, public.device_sync_status, public.upload_auth_failures to service_role;
create policy captures_select_own_org on public.captures for select to authenticated
  using (org_id = public.current_org_id());
create policy device_sync_status_select_own_org on public.device_sync_status for select to authenticated
  using (org_id = public.current_org_id());

create function public.guard_storage_destination()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if row(new.org_id, new.provider, new.bucket, new.region, new.endpoint, new.credentials_secret_ref)
      is distinct from row(old.org_id, old.provider, old.bucket, old.region, old.endpoint, old.credentials_secret_ref) then
    if exists (select 1 from public.captures c where c.storage_config_id = old.id) then
      raise exception 'storage destination is pinned by captures; create a new storage configuration' using errcode = '23514';
    end if;
    new.verified_at := null;
    new.verification_error := null;
    new.is_default := false;
  end if;
  if new.verified_at is null or new.disabled_at is not null then
    new.is_default := false;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_storage_destination() from public, anon, authenticated, service_role;
create trigger storage_destination_guard before update on public.storage_configs
  for each row execute function public.guard_storage_destination();

create function public.set_default_storage(p_config_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_config public.storage_configs%rowtype;
begin
  if v_org is null or public.current_org_role() is distinct from 'org_admin' then
    raise exception 'only an org admin can select default storage' using errcode = '42501';
  end if;
  -- Serializes concurrent choices for the same organization.
  perform 1 from public.organizations where id = v_org for update;
  select * into v_config from public.storage_configs where id = p_config_id and org_id = v_org for update;
  if not found or v_config.verified_at is null or v_config.disabled_at is not null
      or v_config.provider not in ('s3', 'minio') then
    raise exception 'storage must belong to this organization, be enabled and pass its connection test' using errcode = '22023';
  end if;
  update public.storage_configs set is_default = false where org_id = v_org and is_default and id <> p_config_id;
  update public.storage_configs set is_default = true where id = p_config_id;
end;
$$;

create function public.set_storage_enabled(p_config_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or public.current_org_role() is distinct from 'org_admin' then
    raise exception 'only an org admin can enable or disable storage' using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'enabled is required' using errcode = '22004'; end if;
  perform 1 from public.organizations where id = v_org for update;
  update public.storage_configs
    set disabled_at = case when p_enabled then null else coalesce(disabled_at, now()) end
    where id = p_config_id and org_id = v_org;
  if not found then raise exception 'storage configuration not found' using errcode = '22023'; end if;
end;
$$;

create function public.set_site_storage(p_site_id uuid, p_config_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or public.current_org_role() is distinct from 'org_admin' then
    raise exception 'only an org admin can select site storage' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = v_org for update;
  perform 1 from public.sites where id = p_site_id and org_id = v_org for update;
  if not found then raise exception 'site not found' using errcode = '22023'; end if;
  if p_config_id is not null then
    perform 1 from public.storage_configs where id = p_config_id and org_id = v_org
      and verified_at is not null and disabled_at is null and provider in ('s3', 'minio') for share;
    if not found then raise exception 'site storage must belong to this organization, be enabled and verified' using errcode = '22023'; end if;
  end if;
  update public.sites set storage_config_id = p_config_id where id = p_site_id;
end;
$$;

create function public.set_device_upload_enabled(p_device_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or coalesce(public.current_org_role(), '') not in ('org_admin', 'device_admin') then
    raise exception 'only an org admin or device admin can enable or revoke device uploads' using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'enabled is required' using errcode = '22004'; end if;
  update public.devices
    set upload_revoked_at = case when p_enabled then null else coalesce(upload_revoked_at, now()) end
    where id = p_device_id and org_id = v_org;
  if not found then raise exception 'device not found' using errcode = '22023'; end if;
end;
$$;

revoke all on function public.set_default_storage(uuid), public.set_storage_enabled(uuid, boolean),
  public.set_site_storage(uuid, uuid), public.set_device_upload_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_default_storage(uuid), public.set_storage_enabled(uuid, boolean),
  public.set_site_storage(uuid, uuid), public.set_device_upload_enabled(uuid, boolean) to authenticated;

create function public.authenticate_upload_device(
  p_serial_number text, p_hardware_serial text, p_device_identity_secret text
)
returns table (device_id uuid, org_id uuid, site_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_device public.devices%rowtype;
  v_failures integer;
  v_ok boolean;
  v_dummy_hash constant text := '$2a$10$jVLZEJOjyRtwFOTwqL0dEuJCiZAxBmM9rf5LrgYr5yPGFXFIsvliG';
begin
  if p_serial_number is null or octet_length(p_serial_number) not between 1 and 128
    or p_hardware_serial is null or p_hardware_serial !~ '^[0-9a-fA-F]{16}$'
    or p_device_identity_secret is null or octet_length(p_device_identity_secret) not between 1 and 72 then
    return;
  end if;
  select * into v_device from public.devices d where d.serial_number = p_serial_number;
  if not found then perform extensions.crypt(p_device_identity_secret, v_dummy_hash); return; end if;
  select f.failures into v_failures from public.upload_auth_failures f
    where f.device_id = v_device.id and f.window_started_at > now() - interval '15 minutes';
  if coalesce(v_failures, 0) >= 10 then
    perform extensions.crypt(p_device_identity_secret, v_dummy_hash);
    return;
  end if;
  v_ok := v_device.device_identity_hash = extensions.crypt(p_device_identity_secret, v_device.device_identity_hash);
  if not v_ok or v_device.hardware_serial <> lower(p_hardware_serial) then
    insert into public.upload_auth_failures as f (device_id) values (v_device.id)
    on conflict on constraint upload_auth_failures_pkey do update set
      failures = case when f.window_started_at <= now() - interval '15 minutes' then 1 else least(f.failures + 1, 10) end,
      window_started_at = case when f.window_started_at <= now() - interval '15 minutes' then now() else f.window_started_at end;
    return;
  end if;
  if v_device.org_id is null or v_device.status = 'unclaimed' or v_device.upload_revoked_at is not null then return; end if;
  return query select v_device.id, v_device.org_id, v_device.site_id;
end;
$$;

create function public.reserve_capture(
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
  v_key := v_device.org_id::text || '/' || p_device_id::text || '/'
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

-- Shared lock/ownership check for trusted upload transitions. There is no
-- client EXECUTE grant, including service_role: only the owning functions use
-- this helper. Device/config locks hold through the caller's transaction.
create function public.lock_authorized_capture(p_device_id uuid, p_capture_id uuid)
returns public.captures language plpgsql security definer set search_path = '' as $$
declare v_device public.devices%rowtype; v_capture public.captures%rowtype;
begin
  select * into v_device from public.devices where id = p_device_id for share;
  if not found or v_device.org_id is null or v_device.status = 'unclaimed' or v_device.upload_revoked_at is not null then
    raise exception 'device uploads are not authorized' using errcode = '42501';
  end if;
  select * into v_capture from public.captures where capture_id = p_capture_id and device_id = p_device_id
    and org_id = v_device.org_id for update;
  if not found then raise exception 'capture not found' using errcode = '22023'; end if;
  if v_capture.status <> 'verified' then
    perform 1 from public.storage_configs where id = v_capture.storage_config_id and org_id = v_device.org_id
      and disabled_at is null and verified_at is not null for share;
    if not found then raise exception 'pinned storage destination is unavailable' using errcode = '55000'; end if;
  end if;
  return v_capture;
end;
$$;
revoke all on function public.lock_authorized_capture(uuid, uuid) from public, anon, authenticated, service_role;

create function public.begin_capture_upload(p_device_id uuid, p_capture_id uuid)
returns setof public.captures language plpgsql security definer set search_path = '' as $$
declare v_capture public.captures%rowtype;
begin
  v_capture := public.lock_authorized_capture(p_device_id, p_capture_id);
  if v_capture.status <> 'verified' then
    update public.captures set status = 'uploading', attempts = attempts + 1, last_error = null
      where capture_id = p_capture_id returning * into v_capture;
  end if;
  return next v_capture;
end;
$$;

create function public.fail_capture_upload(p_device_id uuid, p_capture_id uuid, p_last_error text)
returns setof public.captures language plpgsql security definer set search_path = '' as $$
declare v_capture public.captures%rowtype;
begin
  v_capture := public.lock_authorized_capture(p_device_id, p_capture_id);
  if p_last_error is null or octet_length(p_last_error) > 1024 then
    raise exception 'bounded error message is required' using errcode = '22023';
  end if;
  if v_capture.status <> 'verified' then
    update public.captures set status = 'needs_attention', last_error = p_last_error
      where capture_id = p_capture_id returning * into v_capture;
    insert into public.device_sync_status (device_id, org_id, last_error)
      values (p_device_id, v_capture.org_id, p_last_error)
      on conflict (device_id) do update set last_error = excluded.last_error, last_contact_at = now();
  end if;
  return next v_capture;
end;
$$;

create function public.verify_capture_receipt(p_device_id uuid, p_capture_id uuid, p_provider_version text default null)
returns setof public.captures language plpgsql security definer set search_path = '' as $$
declare v_capture public.captures%rowtype;
begin
  v_capture := public.lock_authorized_capture(p_device_id, p_capture_id);
  if octet_length(p_provider_version) > 2048 then raise exception 'invalid provider version' using errcode = '22023'; end if;
  if v_capture.status <> 'verified' then
    update public.captures set status = 'verified', verified_at = now(), last_error = null, provider_version = p_provider_version
      where capture_id = p_capture_id returning * into v_capture;
    insert into public.device_sync_status (device_id, org_id, last_verified_at)
      values (p_device_id, v_capture.org_id, v_capture.verified_at)
      on conflict (device_id) do update set last_verified_at = excluded.last_verified_at, last_contact_at = now(), last_error = null;
  end if;
  return next v_capture;
end;
$$;

create function public.report_device_sync_status(
  p_device_id uuid, p_queued_count bigint, p_queued_bytes bigint, p_last_error text default null
)
returns setof public.device_sync_status language plpgsql security definer set search_path = '' as $$
declare v_device public.devices%rowtype;
begin
  select * into v_device from public.devices where id = p_device_id for share;
  if not found or v_device.org_id is null or v_device.status = 'unclaimed' or v_device.upload_revoked_at is not null then
    raise exception 'device uploads are not authorized' using errcode = '42501';
  end if;
  return query insert into public.device_sync_status (device_id, org_id, queued_count, queued_bytes, last_error)
    values (p_device_id, v_device.org_id, p_queued_count, p_queued_bytes, p_last_error)
    on conflict (device_id) do update set queued_count = excluded.queued_count,
      queued_bytes = excluded.queued_bytes, last_error = excluded.last_error, last_contact_at = now()
    returning *;
end;
$$;

revoke all on function public.authenticate_upload_device(text, text, text),
  public.reserve_capture(uuid, uuid, timestamptz, text, text, bigint, text, jsonb),
  public.begin_capture_upload(uuid, uuid), public.fail_capture_upload(uuid, uuid, text),
  public.verify_capture_receipt(uuid, uuid, text), public.report_device_sync_status(uuid, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.authenticate_upload_device(text, text, text),
  public.reserve_capture(uuid, uuid, timestamptz, text, text, bigint, text, jsonb),
  public.begin_capture_upload(uuid, uuid), public.fail_capture_upload(uuid, uuid, text),
  public.verify_capture_receipt(uuid, uuid, text), public.report_device_sync_status(uuid, bigint, bigint, text)
  to service_role;

comment on table public.captures is 'Immutable capture manifests and trusted cloud delivery receipts. Object keys and destination UUIDs are assigned by reserve_capture; browser access is read-only within the active organization.';
comment on column public.devices.upload_revoked_at is 'Revokes new upload requests and completion receipts independently of heartbeat/claim credentials. Existing short-lived provider permissions expire separately.';
comment on column public.storage_configs.verified_at is 'Set only by the trusted connection test after provider upload/read verification. Destination changes invalidate this timestamp.';
