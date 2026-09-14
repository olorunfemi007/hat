-- Recoverable GUI setup, cancellation, and credential lifecycle.
alter table public.storage_connections drop constraint storage_connections_status_check;
alter table public.storage_connections add constraint storage_connections_status_check
  check (status in ('pending','connected','disconnected','cancelled'));
alter table public.storage_connection_events drop constraint storage_connection_events_event_check;
alter table public.storage_connection_events add constraint storage_connection_events_event_check
  check (event in ('setup_started','connected','credentials_rotated','disconnected','reconnected','setup_cancelled'));

create function public.cancel_storage_connection(p_actor uuid,p_org uuid,p_id uuid,p_revision integer)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.storage_connections%rowtype;
begin
  perform public.lock_storage_connection_admin(p_actor,p_org);
  select * into c from public.storage_connections where id=p_id and org_id=p_org for update;
  if not found then raise exception 'setup not found' using errcode='42501'; end if;
  if p_revision is null or c.revision <> p_revision then
    raise exception 'setup changed; reload before trying again' using errcode='40001';
  end if;
  if c.status <> 'pending' or c.config_id is not null then
    raise exception 'only unfinished setups can be cancelled' using errcode='22023';
  end if;
  delete from public.storage_connection_secrets where connection_id=p_id;
  update public.storage_connections set status='cancelled',revision=revision+1,updated_at=now() where id=p_id;
  insert into public.storage_connection_events(org_id,connection_id,actor_id,event)
    values(p_org,p_id,p_actor,'setup_cancelled');
end;
$$;
revoke all on function public.cancel_storage_connection(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.cancel_storage_connection(uuid,uuid,uuid,integer) to service_role;

create or replace function public.save_storage_connection(p_actor uuid, p_org uuid, p_id uuid, p_revision integer,
 p_details jsonb, p_key_id text, p_ciphertext text, p_make_default boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.storage_connections%rowtype; v_config uuid; v_event text := 'connected';
begin
  perform public.lock_storage_connection_admin(p_actor,p_org);
  if p_revision is null or p_revision < 0 then raise exception 'invalid revision' using errcode='22023'; end if;
  select * into c from public.storage_connections where id=p_id for update;
  if found then
    if c.status = 'cancelled' then raise exception 'setup was cancelled' using errcode='22023'; end if;
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


comment on column public.storage_connections.external_id is
  'Server-generated customer binding for AWS trust policies; not a password or secret. Role enrollment also verifies rejection of missing/incorrect IDs.';
