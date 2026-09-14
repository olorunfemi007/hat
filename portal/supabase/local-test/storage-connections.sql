-- Run with capture-sync-run.sh. Each assertion uses real database grants/RLS,
-- not a mocked repository. All extra fixtures are rolled back at completion.
begin;
create temporary table connection_test_results (label text not null);
grant insert, select on connection_test_results to anon, authenticated, service_role;
create function pg_temp.assert_true(p_ok boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  insert into pg_temp.connection_test_results values (p_label);
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.expect_error(p_sql text, p_state text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_state then raise exception 'FAIL: % (expected %, got %: %)', p_label, p_state, sqlstate, sqlerrm; end if;
    insert into pg_temp.connection_test_results values (p_label);
    raise notice 'PASS: %', p_label;
    return;
  end;
  raise exception 'FAIL: % (statement unexpectedly succeeded)', p_label;
end;
$$;

-- Uses the existing Alpha/Bravo fixtures in the isolated test database.
set local role service_role;
select public.begin_storage_connection('00000000-0000-0000-0000-0000000030a1','00000000-0000-0000-0000-0000000000a1','cc000000-0000-4000-8000-000000000001','{"name":"Audit AWS","bucket":"audit-bucket","region":"us-east-1"}');
select pg_temp.assert_true((select length(external_id)=40 and status='pending' from public.storage_connections where id='cc000000-0000-4000-8000-000000000001'),'AWS draft stores generated external ID');
select pg_temp.expect_error($q$select public.begin_storage_connection('00000000-0000-0000-0000-0000000030a3','00000000-0000-0000-0000-0000000000a1','cc000000-0000-4000-8000-000000000002','{}')$q$,'42501','Viewer actor cannot start setup through privileged RPC');
select pg_temp.expect_error($q$select public.begin_storage_connection('00000000-0000-0000-0000-0000000030b1','00000000-0000-0000-0000-0000000000a1','cc000000-0000-4000-8000-000000000002','{}')$q$,'42501','Other organization admin cannot start setup');
select public.save_storage_connection('00000000-0000-0000-0000-0000000030a1','00000000-0000-0000-0000-0000000000a1','cc000000-0000-4000-8000-000000000003',0,'{"name":"Audit MinIO","provider":"minio","bucket":"audit-minio","region":"us-east-1","endpoint":"https://storage.example.test","auth_mode":"keys"}','fixture','opaque-encrypted-fixture',true);
select pg_temp.assert_true((select status='connected' and revision=1 and config_id is not null from public.storage_connections where id='cc000000-0000-4000-8000-000000000003'),'Save creates connected metadata with revision and destination');
select pg_temp.assert_true((select is_default and verified_at is not null from public.storage_configs where credentials_secret_ref='connection:cc000000-0000-4000-8000-000000000003'),'Atomic save activates verified default');
reset role;
set local role anon;
select pg_temp.expect_error('select * from public.storage_connections','42501','Anonymous cannot read connection metadata');
select pg_temp.expect_error('select * from public.storage_connection_secrets','42501','Anonymous cannot read encrypted secrets');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000030a1"}';
select pg_temp.assert_true((select count(*)=2 from public.storage_connections),'Own organization admin can read metadata');
select pg_temp.assert_true((select count(*)=2 from public.storage_connection_events),'Own organization admin can read audit events');
select pg_temp.expect_error('select * from public.storage_connection_secrets','42501','Even organization admin cannot read secret ciphertext');
select pg_temp.expect_error('update public.storage_connections set status=''connected''','42501','Browser cannot directly mutate connection metadata');
select pg_temp.expect_error($q$select public.disconnect_storage_connection('00000000-0000-0000-0000-0000000030a1','00000000-0000-0000-0000-0000000000a1','cc000000-0000-4000-8000-000000000003',1)$q$,'42501','Browser cannot call service-only RPC with a forged actor');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000030a3"}';
select pg_temp.assert_true((select count(*)=0 from public.storage_connections),'Viewer cannot read connection metadata');
select pg_temp.assert_true((select count(*)=0 from public.storage_connection_events),'Viewer cannot read connection audit events');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000030b1"}';
select pg_temp.assert_true((select count(*)=0 from public.storage_connections),'Other organization cannot read connection metadata');
reset role;
set local role service_role;
select pg_temp.expect_error($q$select public.disconnect_storage_connection('00000000-0000-0000-0000-0000000030b1','00000000-0000-0000-0000-0000000000b1','cc000000-0000-4000-8000-000000000003',1)$q$,'42501','Cross-organization disconnect is rejected');
select pg_temp.expect_error($q$select public.disconnect_storage_connection('00000000-0000-0000-0000-0000000030a1','00000000-0000-0000-0000-0000000000a1','cc000000-0000-4000-8000-000000000003',0)$q$,'40001','Stale disconnect revision is rejected');
select public.disconnect_storage_connection('00000000-0000-0000-0000-0000000030a1','00000000-0000-0000-0000-0000000000a1','cc000000-0000-4000-8000-000000000003',1);
select pg_temp.assert_true((select count(*)=0 from public.storage_connection_secrets),'Disconnect deletes secrets');
select pg_temp.assert_true((select disabled_at is not null and not is_default and verified_at is null from public.storage_configs where credentials_secret_ref='connection:cc000000-0000-4000-8000-000000000003'),'Disconnect disables destination and clears default and verification');
select public.save_storage_connection('00000000-0000-0000-0000-0000000030a1','00000000-0000-0000-0000-0000000000a1','cc000000-0000-4000-8000-000000000003',2,'{"name":"Audit MinIO","provider":"minio","bucket":"audit-minio","region":"us-east-1","endpoint":"https://storage.example.test","auth_mode":"keys"}','fixture','replacement-encrypted-fixture',true);
select pg_temp.assert_true((select status='connected' and revision=3 from public.storage_connections where id='cc000000-0000-4000-8000-000000000003'),'Backend reconnection restores same connection at next revision');
select pg_temp.assert_true((select count(*)=1 from public.storage_configs where credentials_secret_ref='connection:cc000000-0000-4000-8000-000000000003'),'Backend reconnection preserves destination identity');
select pg_temp.assert_true((select count(*)=1 from public.storage_connection_events where event='reconnected'),'Backend reconnection writes audit event');
reset role;
select count(*) as connection_assertions_passed from connection_test_results;
rollback;
