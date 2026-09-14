-- GUI-managed connections. Credentials are encrypted by the portal with a key
-- held outside Postgres. Human clients can read only connection metadata.
create table public.storage_connections (
  id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  provider text not null check (provider in ('s3','minio')),
  bucket text not null check (length(bucket) between 3 and 63),
  region text not null check (length(region) between 1 and 40),
  endpoint text check (length(endpoint) <= 2048),
  auth_mode text not null check (auth_mode in ('role','keys')),
  role_arn text check (length(role_arn) <= 2048),
  external_id text unique,
  status text not null default 'pending' check (status in ('pending','connected','disconnected')),
  revision integer not null default 0 check (revision >= 0),
  config_id uuid unique references public.storage_configs(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (auth_mode <> 'role' or (provider = 's3' and external_id is not null)),
  unique(id, org_id)
);
create table public.storage_connection_secrets (
  connection_id uuid primary key,
  org_id uuid not null,
  key_id text not null check (length(key_id) between 1 and 64),
  ciphertext text not null check (length(ciphertext) between 1 and 32768),
  foreign key (connection_id, org_id) references public.storage_connections(id, org_id) on delete cascade
);
create table public.storage_connection_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.storage_connections(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event text not null check (event in ('setup_started','connected','credentials_rotated','disconnected','reconnected')),
  created_at timestamptz not null default now()
);
alter table public.storage_connections enable row level security;
alter table public.storage_connection_secrets enable row level security;
alter table public.storage_connection_events enable row level security;
revoke all on public.storage_connections, public.storage_connection_secrets, public.storage_connection_events from public, anon, authenticated;
grant select on public.storage_connections, public.storage_connection_events to authenticated;
grant select, insert, update, delete on public.storage_connections, public.storage_connection_secrets, public.storage_connection_events to service_role;
create policy storage_connections_admin_read on public.storage_connections for select to authenticated
 using (org_id = public.current_org_id() and public.current_org_role() = 'org_admin');
create policy storage_connection_events_admin_read on public.storage_connection_events for select to authenticated
 using (org_id = public.current_org_id() and public.current_org_role() = 'org_admin');

-- Recheck the verified user's live membership inside each privileged mutation.
-- Service role alone cannot turn a stale/demoted browser context into a write.
create function public.lock_storage_connection_admin(p_actor uuid, p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.organizations where id = p_org for update;
  perform 1 from public.organization_members where user_id = p_actor and org_id = p_org and role = 'org_admin' for share;
  if not found then raise exception 'organization administrator required' using errcode = '42501'; end if;
end;
$$;
revoke all on function public.lock_storage_connection_admin(uuid,uuid) from public,anon,authenticated,service_role;

-- external_id is generated HERE, server-side, never accepted from a caller:
-- the entire point of AWS's external-id mechanism is that it's a secret only
-- this portal and the one customer setting up this specific connection ever
-- see -- a caller-suppliable external_id would let any caller pick a value
-- an attacker already knows, which is exactly the confused-deputy scenario
-- external ids exist to prevent (see AWS's own guidance:
-- https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html).
-- 20 random bytes/40 hex chars, matching this project's existing secret-
-- generation convention (0005_provisioning_function.sql).
create function public.begin_storage_connection(p_actor uuid, p_org uuid, p_id uuid, p_details jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_external_id text;
begin
  perform public.lock_storage_connection_admin(p_actor,p_org);
  if (select count(*) from public.storage_connections where org_id=p_org and status='pending') >= 30 then
    raise exception 'finish or disconnect an existing setup first';
  end if;
  v_external_id := encode(extensions.gen_random_bytes(20), 'hex');
  insert into public.storage_connections(id,org_id,name,provider,bucket,region,endpoint,auth_mode,external_id)
    values(p_id,p_org,p_details->>'name','s3',p_details->>'bucket',p_details->>'region',null,'role',v_external_id);
  insert into public.storage_connection_events(org_id,connection_id,actor_id,event) values(p_org,p_id,p_actor,'setup_started');
  return v_external_id;
end;
$$;

create function public.save_storage_connection(p_actor uuid, p_org uuid, p_id uuid, p_revision integer,
 p_details jsonb, p_key_id text, p_ciphertext text, p_make_default boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.storage_connections%rowtype; v_config uuid; v_event text := 'connected';
begin
  perform public.lock_storage_connection_admin(p_actor,p_org);
  select * into c from public.storage_connections where id=p_id for update;
  if found then
    if c.org_id <> p_org then raise exception 'connection not found' using errcode='42501'; end if;
    if c.revision <> p_revision then raise exception 'connection changed; reload before trying again' using errcode='40001'; end if;
    if row(c.provider,c.bucket,c.region,c.endpoint,c.auth_mode) is distinct from
       row(p_details->>'provider',p_details->>'bucket',p_details->>'region',p_details->>'endpoint',p_details->>'auth_mode') then
      raise exception 'create a new connection to change its destination';
    end if;
    v_event := case c.status when 'connected' then 'credentials_rotated' when 'disconnected' then 'reconnected' else 'connected' end;
    v_config := c.config_id;
    update public.storage_connections set name=p_details->>'name',role_arn=p_details->>'role_arn',status='connected',
      revision=revision+1,updated_at=now() where id=p_id;
  else
    if p_revision <> 0 or p_details->>'auth_mode' <> 'keys' then raise exception 'connection setup required'; end if;
    insert into public.storage_connections(id,org_id,name,provider,bucket,region,endpoint,auth_mode,status,revision)
      values(p_id,p_org,p_details->>'name',p_details->>'provider',p_details->>'bucket',p_details->>'region',p_details->>'endpoint','keys','connected',1);
  end if;
  insert into public.storage_connection_secrets(connection_id,org_id,key_id,ciphertext) values(p_id,p_org,p_key_id,p_ciphertext)
    on conflict(connection_id) do update set key_id=excluded.key_id,ciphertext=excluded.ciphertext;
  if v_config is null then
    insert into public.storage_configs(org_id,name,provider,bucket,region,endpoint,credentials_secret_ref,verified_at)
      values(p_org,p_details->>'name',p_details->>'provider',p_details->>'bucket',p_details->>'region',p_details->>'endpoint','connection:'||p_id::text,now()) returning id into v_config;
    update public.storage_connections set config_id=v_config where id=p_id;
  else
    update public.storage_configs set name=p_details->>'name',verified_at=now(),verification_error=null,disabled_at=null where id=v_config;
  end if;
  if p_make_default then
    update public.storage_configs set is_default=false where org_id=p_org and is_default;
    update public.storage_configs set is_default=true where id=v_config;
  end if;
  insert into public.storage_connection_events(org_id,connection_id,actor_id,event) values(p_org,p_id,p_actor,v_event);
  return v_config;
end;
$$;

create function public.disconnect_storage_connection(p_actor uuid,p_org uuid,p_id uuid,p_revision integer)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.storage_connections%rowtype;
begin
  perform public.lock_storage_connection_admin(p_actor,p_org);
  select * into c from public.storage_connections where id=p_id and org_id=p_org for update;
  if not found then raise exception 'connection not found' using errcode='42501'; end if;
  if c.revision <> p_revision then raise exception 'connection changed; reload before trying again' using errcode='40001'; end if;
  delete from public.storage_connection_secrets where connection_id=p_id;
  update public.storage_connections set status='disconnected',revision=revision+1,updated_at=now() where id=p_id;
  update public.storage_configs set disabled_at=now(),is_default=false,verified_at=null,verification_error=null
    where org_id=p_org and credentials_secret_ref='connection:'||p_id::text;
  insert into public.storage_connection_events(org_id,connection_id,actor_id,event) values(p_org,p_id,p_actor,'disconnected');
end;
$$;
revoke all on function public.begin_storage_connection(uuid,uuid,uuid,jsonb),
 public.save_storage_connection(uuid,uuid,uuid,integer,jsonb,text,text,boolean),
 public.disconnect_storage_connection(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.begin_storage_connection(uuid,uuid,uuid,jsonb),
 public.save_storage_connection(uuid,uuid,uuid,integer,jsonb,text,text,boolean),
 public.disconnect_storage_connection(uuid,uuid,uuid,integer) to service_role;

comment on function public.lock_storage_connection_admin(uuid,uuid) is
  'Re-verifies the caller is a LIVE org_admin of p_org inside the same transaction as the mutation -- service_role bypasses RLS entirely, so this is the only real authorization check every storage-connection mutation has. Never grant EXECUTE beyond service_role: it takes p_actor as a trusted parameter, not auth.uid(), by design (called from a server_role context, not directly from a user session).';
comment on function public.begin_storage_connection(uuid,uuid,uuid,jsonb) is
  'Starts an AWS S3 role-based connection setup: generates a fresh server-side external_id (never caller-supplied -- see this function''s own comment) and returns it so the caller can show it to the customer for their IAM trust policy. Does not verify the role_arn works -- that happens in save_storage_connection, once the customer has actually created the role and the caller has confirmed a real STS AssumeRole succeeds.';
comment on function public.save_storage_connection(uuid,uuid,uuid,integer,jsonb,text,text,boolean) is
  'Persists a verified connection (AWS role_arn after a successful STS AssumeRole, or MinIO/S3 static keys after a successful test upload) and upserts the corresponding storage_configs row via the connection:<id> credentials_secret_ref. Trusts the caller to have already performed that verification -- this function has no way to call out to AWS/MinIO itself and does not attempt to. p_revision implements optimistic concurrency (errcode 40001 on mismatch); an AWS connection''s destination (provider/bucket/region/endpoint/auth_mode) cannot be changed in place, only rotated (new role_arn/keys) or replaced with a new connection.';
comment on function public.disconnect_storage_connection(uuid,uuid,uuid,integer) is
  'Deletes the stored secret immediately, marks the connection disconnected, and disables (never deletes) the corresponding storage_configs row so capture uploads stop cleanly rather than erroring against a row that vanished mid-request.';
