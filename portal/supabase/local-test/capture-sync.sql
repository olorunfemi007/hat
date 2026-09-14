-- Run with capture-sync-run.sh. Each assertion uses real database grants/RLS,
-- not a mocked repository. All extra fixtures are rolled back at completion.
begin;
create temporary table capture_test_results (label text not null);
grant insert, select on capture_test_results to anon, authenticated, service_role;
create function pg_temp.assert_true(p_ok boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  insert into pg_temp.capture_test_results values (p_label);
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
    insert into pg_temp.capture_test_results values (p_label);
    raise notice 'PASS: %', p_label;
    return;
  end;
  raise exception 'FAIL: % (statement unexpectedly succeeded)', p_label;
end;
$$;

insert into auth.users (id,email,email_confirmed_at) values
 ('ca000000-0000-0000-0000-000000000001','capture-admin@test.dev',now()),
 ('ca000000-0000-0000-0000-000000000002','capture-viewer@test.dev',now()),
 ('ca000000-0000-0000-0000-000000000003','capture-other-admin@test.dev',now()),
 ('ca000000-0000-0000-0000-000000000004','capture-device-admin@test.dev',now());
insert into public.organizations (id,name) values
 ('ca100000-0000-0000-0000-000000000001','Capture Alpha'),
 ('ca100000-0000-0000-0000-000000000002','Capture Beta');
insert into public.organization_members (org_id,user_id,role) values
 ('ca100000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-000000000001','org_admin'),
 ('ca100000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-000000000002','viewer'),
 ('ca100000-0000-0000-0000-000000000002','ca000000-0000-0000-0000-000000000003','org_admin'),
 ('ca100000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-000000000004','device_admin');
insert into public.sites (id,org_id,name) values
 ('ca200000-0000-0000-0000-000000000001','ca100000-0000-0000-0000-000000000001','Capture Site');
insert into public.devices (id,org_id,site_id,serial_number,hardware_serial,status,claim_code_hash,device_identity_hash) values
 ('ca300000-0000-0000-0000-000000000001','ca100000-0000-0000-0000-000000000001','ca200000-0000-0000-0000-000000000001','CAPTURE-ALPHA','0000000000ca0001','active',extensions.crypt('claim-secret',extensions.gen_salt('bf',4)),extensions.crypt('capture-secret',extensions.gen_salt('bf',4))),
 ('ca300000-0000-0000-0000-000000000002','ca100000-0000-0000-0000-000000000002',null,'CAPTURE-BETA','0000000000ca0002','claimed',extensions.crypt('claim-secret',extensions.gen_salt('bf',4)),extensions.crypt('capture-secret',extensions.gen_salt('bf',4))),
 ('ca300000-0000-0000-0000-000000000003',null,null,'CAPTURE-UNCLAIMED','0000000000ca0003','unclaimed',extensions.crypt('claim-secret',extensions.gen_salt('bf',4)),extensions.crypt('capture-secret',extensions.gen_salt('bf',4)));
insert into public.storage_configs (id,org_id,provider,bucket,region,credentials_secret_ref,verified_at) values
 ('ca400000-0000-0000-0000-000000000001','ca100000-0000-0000-0000-000000000001','s3','capture-alpha','us-east-1','CAPTURE_A',now()),
 ('ca400000-0000-0000-0000-000000000002','ca100000-0000-0000-0000-000000000001','minio','capture-alpha','us-east-1','CAPTURE_B',now()),
 ('ca400000-0000-0000-0000-000000000003','ca100000-0000-0000-0000-000000000002','s3','capture-beta','us-east-1','CAPTURE_C',now()),
 ('ca400000-0000-0000-0000-000000000004','ca100000-0000-0000-0000-000000000001','s3','unverified','us-east-1','CAPTURE_D',null),
 ('ca400000-0000-0000-0000-000000000005','ca100000-0000-0000-0000-000000000001','gcs','unsupported','us-east-1','CAPTURE_E',now());

set local role anon;
select pg_temp.expect_error('select * from public.authenticate_upload_device(''CAPTURE-ALPHA'',''0000000000ca0001'',''capture-secret'')','42501','anonymous clients cannot authenticate devices via private RPC');
select pg_temp.expect_error('select * from public.captures','42501','anonymous clients cannot read capture inventory');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-0000-0000-000000000001"}';
select pg_temp.expect_error('select * from public.authenticate_upload_device(''CAPTURE-ALPHA'',''0000000000ca0001'',''capture-secret'')','42501','portal admins cannot call device authentication RPC');
select pg_temp.expect_error('update public.storage_configs set verified_at = now()','42501','admins cannot forge connection verification');
select pg_temp.expect_error('update public.storage_configs set is_default = true','42501','admins cannot bypass default selection checks');
select pg_temp.expect_error('insert into public.storage_configs(org_id,provider,bucket,credentials_secret_ref,verified_at) values (''ca100000-0000-0000-0000-000000000001'',''s3'',''forged'',''ref'',now())','42501','admins cannot insert preverified storage');
select pg_temp.expect_error('select public.set_default_storage(''ca400000-0000-0000-0000-000000000004'')','22023','unverified storage cannot become default');
select pg_temp.expect_error('select public.set_default_storage(''ca400000-0000-0000-0000-000000000005'')','22023','unsupported storage cannot become default');
select pg_temp.expect_error('select public.set_default_storage(''ca400000-0000-0000-0000-000000000003'')','22023','cross-org storage cannot become default');
select public.set_default_storage('ca400000-0000-0000-0000-000000000001');
select pg_temp.assert_true((select is_default from public.storage_configs where id='ca400000-0000-0000-0000-000000000001'),'verified destination becomes default');
select pg_temp.expect_error('update public.sites set storage_config_id=''ca400000-0000-0000-0000-000000000003''','42501','raw site override bypass denied');
select pg_temp.expect_error('select public.set_site_storage(''ca200000-0000-0000-0000-000000000001'',''ca400000-0000-0000-0000-000000000003'')','22023','cross-org site override denied');
select pg_temp.expect_error('select public.set_device_upload_enabled(''ca300000-0000-0000-0000-000000000002'',false)','22023','cannot revoke another organization device');
select pg_temp.expect_error('update public.devices set upload_revoked_at = now()','42501','raw upload revocation bypass denied');

set local request.jwt.claims = '{"sub":"ca000000-0000-0000-0000-000000000002"}';
select pg_temp.expect_error('select public.set_default_storage(''ca400000-0000-0000-0000-000000000001'')','42501','viewer cannot select storage');
select pg_temp.expect_error('select public.set_device_upload_enabled(''ca300000-0000-0000-0000-000000000001'',false)','42501','viewer cannot revoke device uploads');
reset role;
set local role service_role;
select pg_temp.assert_true((select count(*)=1 from public.authenticate_upload_device('CAPTURE-ALPHA','0000000000CA0001','capture-secret')),'claimed physical device authenticates with case-normalized hardware serial');
select pg_temp.assert_true((select count(*)=0 from public.authenticate_upload_device('CAPTURE-ALPHA','0000000000ca0002','capture-secret')),'wrong physical serial rejected even with correct secret');
select pg_temp.assert_true((select count(*)=0 from public.authenticate_upload_device('CAPTURE-ALPHA','0000000000ca0001','wrong-secret')),'wrong identity secret rejected');
select pg_temp.assert_true((select count(*)=0 from public.authenticate_upload_device('CAPTURE-UNCLAIMED','0000000000ca0003','capture-secret')),'unclaimed device cannot upload');
select pg_temp.assert_true((select count(*)=0 from public.authenticate_upload_device('MISSING','0000000000ca0001','capture-secret')),'unknown serial rejected');
select pg_temp.assert_true((select count(*)=0 from public.authenticate_upload_device(repeat('x',129),'0000000000ca0001','capture-secret')),'unbounded serial input rejected');
select pg_temp.assert_true((select count(*)=0 from public.authenticate_upload_device('CAPTURE-ALPHA','0000000000ca0001',repeat('x',73))),'bcrypt secret truncation input rejected');
select pg_temp.assert_true((select count(*)=1 from public.upload_auth_failures),'unknown serials cannot grow auth throttle table');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000003'',''ca500000-0000-0000-0000-000000000001'',''2026-01-01Z'',''video'',''video/mp4'',100,repeat(''a'',64))','42501','unclaimed device cannot reserve even through trusted call');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000002'',''ca500000-0000-0000-0000-000000000001'',''2026-01-01Z'',''video'',''video/mp4'',100,repeat(''a'',64))','55000','no cross-org fallback when own storage missing');
select pg_temp.assert_true((select storage_config_id='ca400000-0000-0000-0000-000000000001' from public.reserve_capture('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001','2026-01-01Z','video','video/mp4',100,repeat('a',64),'{"trigger":"voice"}')),'capture reserves organization default');
select pg_temp.assert_true((select object_key='ca100000-0000-0000-0000-000000000001/ca300000-0000-0000-0000-000000000001/2026/01/01/ca500000-0000-0000-0000-000000000001.mp4' from public.captures where capture_id='ca500000-0000-0000-0000-000000000001'),'object key generated from server-owned tenancy and device with standard media extension');
select pg_temp.assert_true((select count(*)=1 from public.reserve_capture('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001','2026-01-01Z','video','video/mp4',100,repeat('a',64),'{"trigger":"voice"}')),'identical capture retry returns existing reservation');
select pg_temp.assert_true((select count(*)=1 from public.captures where device_id='ca300000-0000-0000-0000-000000000001'),'retry creates no duplicate capture');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000002'',''ca500000-0000-0000-0000-000000000001'',''2026-01-01Z'',''video'',''video/mp4'',100,repeat(''a'',64),''{"trigger":"voice"}'')','23505','capture id cannot be stolen by another device');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000001'',''2026-01-01Z'',''video'',''video/mp4'',101,repeat(''a'',64),''{"trigger":"voice"}'')','23505','idempotent retry cannot change byte size');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000001'',''2026-01-01Z'',''video'',''video/mp4'',100,repeat(''b'',64),''{"trigger":"voice"}'')','23505','idempotent retry cannot change checksum');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000001'',''2026-01-01Z'',''video'',''video/mp4'',100,repeat(''a'',64),''{}'')','23505','idempotent retry cannot rewrite metadata');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000010'',''2026-01-01Z'',''video'',''image/jpeg'',100,repeat(''a'',64))','23514','capture type must match media kind');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000010'',''2026-01-01Z'',''video'',''video/mp4'',67108865,repeat(''a'',64))','23514','segment size limit enforced in database');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000010'',''2026-01-01Z'',''video'',''video/mp4'',100,repeat(''a'',64),jsonb_build_object(''x'',repeat(''a'',8192)))','23514','oversized metadata rejected');
select pg_temp.expect_error('select * from public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000010'',''infinity'',''video'',''video/mp4'',100,repeat(''a'',64))','22023','infinite capture time rejected');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-0000-0000-000000000001"}';
select pg_temp.expect_error('update public.storage_configs set bucket=''changed'' where id=''ca400000-0000-0000-0000-000000000001''','23514','used destination cannot be changed');
select pg_temp.expect_error('delete from public.storage_configs where id=''ca400000-0000-0000-0000-000000000001''','23503','used destination cannot be deleted');
update public.storage_configs set name='Friendly label' where id='ca400000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select verified_at is not null from public.storage_configs where id='ca400000-0000-0000-0000-000000000001'),'display-only edits retain connection verification');
select public.set_default_storage('ca400000-0000-0000-0000-000000000002');
select pg_temp.assert_true((select count(*)=1 from public.storage_configs where is_default),'switching default leaves exactly one default');
select public.set_site_storage('ca200000-0000-0000-0000-000000000001','ca400000-0000-0000-0000-000000000001');
select pg_temp.expect_error('update public.captures set status=''verified'',verified_at=now()','42501','admins cannot forge capture receipts');
select pg_temp.expect_error('delete from public.captures','42501','admins cannot erase delivery history');
select pg_temp.expect_error('select public.verify_capture_receipt(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000001'',''forged'')','42501','admins cannot invoke trusted receipt RPC');
reset role;
set local role service_role;
select pg_temp.assert_true((select storage_config_id='ca400000-0000-0000-0000-000000000001' from public.reserve_capture('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001','2026-01-01Z','video','video/mp4',100,repeat('a',64),'{"trigger":"voice"}')),'pending retry remains pinned after default changes');
select pg_temp.assert_true((select storage_config_id='ca400000-0000-0000-0000-000000000001' from public.reserve_capture('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000002','2026-01-01Z','sensor','application/json',10,repeat('b',64))),'site override wins over organization default');
select pg_temp.expect_error('select public.begin_capture_upload(''ca300000-0000-0000-0000-000000000002'',''ca500000-0000-0000-0000-000000000001'')','22023','another device cannot begin owned capture');
select pg_temp.expect_error('select public.verify_capture_receipt(''ca300000-0000-0000-0000-000000000002'',''ca500000-0000-0000-0000-000000000001'',''version'')','22023','another device cannot complete owned capture');
select pg_temp.assert_true((select status='uploading' and attempts=1 from public.begin_capture_upload('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001')),'upload attempt counted and visible');
select pg_temp.assert_true((select status='needs_attention' from public.fail_capture_upload('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001','Storage unavailable')),'trusted failure records needs attention');
select pg_temp.assert_true((select status='uploading' and attempts=2 from public.begin_capture_upload('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001')),'retry recovers failed upload');
select pg_temp.assert_true((select status='verified' and verified_at is not null and provider_version='version-1' from public.verify_capture_receipt('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001','version-1')),'trusted completion stores provider version');
select pg_temp.assert_true((select provider_version='version-1' from public.verify_capture_receipt('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001','version-2')),'repeated completion preserves original verified receipt');
select pg_temp.assert_true((select status='verified' and attempts=2 from public.begin_capture_upload('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001')),'verified capture is never reopened');
select pg_temp.assert_true((select status='verified' from public.fail_capture_upload('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001','Late failure')),'late error cannot downgrade verified capture');
select pg_temp.assert_true((select queued_count=2 and queued_bytes=110 and last_verified_at is not null from public.report_device_sync_status('ca300000-0000-0000-0000-000000000001',2,110,null)),'queue report retains server-controlled last verification');
select pg_temp.expect_error('select public.report_device_sync_status(''ca300000-0000-0000-0000-000000000001'',-1,110,null)','23514','negative queue count rejected');
select pg_temp.expect_error('update public.captures set storage_config_id=''ca400000-0000-0000-0000-000000000003'' where capture_id=''ca500000-0000-0000-0000-000000000001''','23503','composite FK prevents cross-org storage even in trusted writes');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-0000-0000-000000000002"}';
select pg_temp.assert_true((select count(*)=2 from public.captures),'viewer can see own organization captures');
select pg_temp.assert_true((select count(*)=1 from public.device_sync_status),'viewer can see own organization sync state');
select pg_temp.expect_error('update public.device_sync_status set last_verified_at=now()','42501','viewer cannot forge sync verification');
set local request.jwt.claims = '{"sub":"ca000000-0000-0000-0000-000000000003"}';
select pg_temp.assert_true((select count(*)=0 from public.captures),'other organization cannot read captures');
select pg_temp.assert_true((select count(*)=0 from public.device_sync_status),'other organization cannot read sync state');
set local request.jwt.claims = '{"sub":"ca000000-0000-0000-0000-000000000004"}';
select public.set_device_upload_enabled('ca300000-0000-0000-0000-000000000001',false);
select pg_temp.assert_true((select upload_revoked_at is not null from public.devices where id='ca300000-0000-0000-0000-000000000001'),'device admin can revoke own device');
reset role;
set local role service_role;
select pg_temp.assert_true((select count(*)=0 from public.authenticate_upload_device('CAPTURE-ALPHA','0000000000ca0001','capture-secret')),'revoked device authentication denied');
select pg_temp.expect_error('select public.verify_capture_receipt(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000002'',''version'')','42501','revocation between authentication and completion is enforced');
select pg_temp.expect_error('select public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000002'',''2026-01-01Z'',''sensor'',''application/json'',10,repeat(''b'',64))','42501','revoked device cannot retry pending capture');
select pg_temp.assert_true((select count(*)=1 from public.device_heartbeat('CAPTURE-ALPHA','capture-secret','0000000000ca0001')),'upload revocation leaves existing heartbeat working');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-0000-0000-000000000001"}';
select public.set_device_upload_enabled('ca300000-0000-0000-0000-000000000001',true);
select public.set_storage_enabled('ca400000-0000-0000-0000-000000000001',false);
reset role;
set local role service_role;
select pg_temp.expect_error('select public.verify_capture_receipt(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000002'',''version'')','55000','disabled pinned destination blocks completion');
select pg_temp.expect_error('select public.reserve_capture(''ca300000-0000-0000-0000-000000000001'',''ca500000-0000-0000-0000-000000000003'',''2026-01-01Z'',''sensor'',''application/json'',10,repeat(''b'',64))','55000','disabled site override does not silently route to organization default');
select pg_temp.assert_true((select status='verified' from public.reserve_capture('ca300000-0000-0000-0000-000000000001','ca500000-0000-0000-0000-000000000001','2026-01-01Z','video','video/mp4',100,repeat('a',64),'{"trigger":"voice"}')),'existing verified receipt remains readable after destination disabled');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-0000-0000-000000000001"}';
select public.set_site_storage('ca200000-0000-0000-0000-000000000001',null);
select public.set_storage_enabled('ca400000-0000-0000-0000-000000000002',false);
select pg_temp.assert_true((select count(*)=0 from public.storage_configs where is_default),'disabling default removes it from routing');
select public.set_storage_enabled('ca400000-0000-0000-0000-000000000002',true);
select pg_temp.assert_true((select not is_default from public.storage_configs where id='ca400000-0000-0000-0000-000000000002'),'reenabling storage does not silently make it default');
update public.storage_configs set endpoint='https://new.example.invalid' where id='ca400000-0000-0000-0000-000000000002';
select pg_temp.assert_true((select verified_at is null from public.storage_configs where id='ca400000-0000-0000-0000-000000000002'),'editing unused destination invalidates previous test');
reset role;
set local role service_role;
-- Two prior wrong logins plus eight more exhaust only upload authentication.
do $$ begin for i in 1..8 loop perform public.authenticate_upload_device('CAPTURE-ALPHA','0000000000ca0001','wrong-secret'); end loop; end $$;
select pg_temp.assert_true((select count(*)=0 from public.authenticate_upload_device('CAPTURE-ALPHA','0000000000ca0001','capture-secret')),'ten failed logins throttle correct upload credential');
select pg_temp.assert_true((select count(*)=1 from public.device_heartbeat('CAPTURE-ALPHA','capture-secret','0000000000ca0001')),'upload auth attacks cannot block heartbeat');
select pg_temp.assert_true((select count(*)=1 from public.authenticate_upload_device('CAPTURE-BETA','0000000000ca0002','capture-secret')),'upload throttle is per device');
update public.upload_auth_failures set window_started_at=now()-interval '16 minutes' where device_id='ca300000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select count(*)=1 from public.authenticate_upload_device('CAPTURE-ALPHA','0000000000ca0001','capture-secret')),'upload authentication resumes after throttle window');
reset role;
select count(*) as capture_sync_assertions_passed from pg_temp.capture_test_results;
rollback;
