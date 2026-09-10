-- 01_seed_test_data.sql -- fixed, known-id test fixtures for the assertion
-- suite (deliberately not supabase/seed.sql's provision_devices() output,
-- since tests need to know the plaintext claim_code / device_identity
-- values up front to exercise both the success and failure paths).
-- Run as postgres (superuser => bypasses RLS for setup).
--
-- Sep 2026: rewritten for the Clerk -> native Supabase Auth redesign (see
-- 0001_schema.sql's header). Every persona below is now a real auth.users
-- row with a real uuid id, and org membership/role comes from seeded
-- organization_members rows instead of being embedded in a JWT claim --
-- run_tests.sh's claims for each persona are now just {"sub": "<uuid>"}.

-- ---------------------------------------------------------------------------
-- auth.users -- one row per test persona.
-- ---------------------------------------------------------------------------
-- email_confirmed_at = now() for every persona here: they all represent
-- real, already-onboarded accounts. This matters as of the account-
-- squatting fix in invite_member()/handle_new_user_invites() (0007/0008):
-- an unconfirmed auth.users row is deliberately treated as "no real account
-- yet" (see those files' comments), so a test persona meant to already have
-- a legitimate account must be seeded as confirmed, or it would silently
-- fall through to the pending-invite path instead of the paths these tests
-- actually intend to exercise.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000030a1', 'alpha-admin@test.dev', now()),
  ('00000000-0000-0000-0000-0000000030a2', 'alpha-devadmin@test.dev', now()),
  ('00000000-0000-0000-0000-0000000030a3', 'alpha-viewer@test.dev', now()),
  ('00000000-0000-0000-0000-0000000030a4', 'alpha-sitemgr@test.dev', now()),
  ('00000000-0000-0000-0000-0000000030b1', 'bravo-admin@test.dev', now()),
  -- Belongs to both org_alpha (as viewer, earlier membership -- the
  -- default-active-org fallback case) and org_bravo (as org_admin, later
  -- membership) -- exercises multi-org membership and active-org switching
  -- (Group I).
  ('00000000-0000-0000-0000-0000000030c1', 'multi-org@test.dev', now()),
  -- A real account, zero memberships anywhere -- the "no active org" safe
  -- degrade case (Group B), now via an actual auth.users row rather than a
  -- claims-only fake identity (auth.uid() requires a real uuid; Clerk's
  -- "user_no_org" text sub could never have satisfied that cast).
  ('00000000-0000-0000-0000-0000000030c2', 'no-org@test.dev', now()),
  -- Has an account, but is not (yet) a member of any org used by these
  -- tests -- used to exercise invite_member()'s "existing user" branch
  -- (Group H). Deliberately confirmed: this persona represents a
  -- legitimate existing account, which is exactly the case that branch
  -- should match.
  ('00000000-0000-0000-0000-0000000030c3', 'existing-user@test.dev', now()),
  -- Sole org_admin of org_charlie below -- the "last admin" guard tests
  -- (Group J).
  ('00000000-0000-0000-0000-0000000030d1', 'charlie-admin@test.dev', now()),
  -- A second, dedicated "real account, zero memberships" persona, used only
  -- by the create_organization() test (Group G) so that test's side effect
  -- (it gains a membership the instant it succeeds) never contaminates
  -- no-org@test.dev's "always zero memberships" invariant relied on
  -- elsewhere.
  ('00000000-0000-0000-0000-0000000030c4', 'fresh-signup@test.dev', now());

-- Deliberately UNCONFIRMED (no email_confirmed_at) -- represents an
-- attacker who has self-signed-up with an email they don't actually
-- control, squatting it before its real owner is ever invited. Used to
-- prove invite_member()'s existing-user branch treats this as "no real
-- account yet" and falls through to the pending-invite path instead of
-- handing this row immediate org membership (Group H).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000030c5', 'squatted@test.dev');

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name, plan) values
  ('00000000-0000-0000-0000-0000000000a1', 'Alpha Construction', 'pro'),
  ('00000000-0000-0000-0000-0000000000b1', 'Bravo Builders',     'free'),
  ('00000000-0000-0000-0000-0000000000c1', 'Charlie Contracting', 'free');

-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
insert into public.organization_members (org_id, user_id, role, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000030a1', 'org_admin',     now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000030a2', 'device_admin',  now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000030a3', 'viewer',        now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000030a4', 'site_manager',  now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000030b1', 'org_admin',     now() - interval '10 days'),
  -- multi_org_user: alpha membership (viewer) predates bravo membership
  -- (org_admin) -- so their default active org (no explicit
  -- set_active_org() call yet) should resolve to alpha, as viewer.
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000030c1', 'viewer',        now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000030c1', 'org_admin',     now() - interval '1 days'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000030d1', 'org_admin',     now() - interval '10 days');

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------
insert into public.sites (id, org_id, name, address) values
  ('00000000-0000-0000-0000-0000000010a1', '00000000-0000-0000-0000-0000000000a1', 'Alpha Site 1', '1 Alpha Way'),
  ('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000000b1', 'Bravo Site 1', '1 Bravo Way');

-- claim_code / device_identity_secret plaintext used by the test suite:
--   DEV-ALPHA-001  claim=claimcode-alpha-001   identity=identity-alpha-001
--   DEV-ALPHA-002  claim=claimcode-alpha-002   identity=identity-alpha-002  (pre-claimed into org_alpha, active)
--   DEV-UNCLAIMED  claim=claimcode-unclaimed   identity=identity-unclaimed (stays unclaimed)
insert into public.devices (id, serial_number, claim_code_hash, device_identity_hash, status)
values
  ('00000000-0000-0000-0000-0000000020a1', 'DEV-ALPHA-001',
    extensions.crypt('claimcode-alpha-001', extensions.gen_salt('bf', 4)),
    extensions.crypt('identity-alpha-001', extensions.gen_salt('bf', 4)),
    'unclaimed'),
  ('00000000-0000-0000-0000-0000000020a2', 'DEV-UNCLAIMED',
    extensions.crypt('claimcode-unclaimed', extensions.gen_salt('bf', 4)),
    extensions.crypt('identity-unclaimed', extensions.gen_salt('bf', 4)),
    'unclaimed');

-- pre-claimed device already in org_alpha, status active, for update/select
-- isolation + heartbeat tests. claimed_by_user_id is now a real auth.users
-- uuid (alpha_admin) rather than a Clerk-shaped text id.
insert into public.devices (
  id, org_id, site_id, serial_number, claim_code_hash, device_identity_hash,
  status, claimed_at, claimed_by_user_id, display_name
) values (
  '00000000-0000-0000-0000-0000000020a3',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000010a1',
  'DEV-ALPHA-002',
  extensions.crypt('claimcode-alpha-002', extensions.gen_salt('bf', 4)),
  extensions.crypt('identity-alpha-002', extensions.gen_salt('bf', 4)),
  'active',
  now() - interval '2 days',
  '00000000-0000-0000-0000-0000000030a1',
  'Alpha Device 002'
);

-- A stale-but-active device in org_bravo, to exercise
-- mark_stale_devices_offline().
insert into public.devices (
  id, org_id, site_id, serial_number, claim_code_hash, device_identity_hash,
  status, claimed_at, claimed_by_user_id, last_seen_at, display_name
) values (
  '00000000-0000-0000-0000-0000000020b1',
  '00000000-0000-0000-0000-0000000000b1',
  '00000000-0000-0000-0000-0000000010b1',
  'DEV-BRAVO-001',
  extensions.crypt('claimcode-bravo-001', extensions.gen_salt('bf', 4)),
  extensions.crypt('identity-bravo-001', extensions.gen_salt('bf', 4)),
  'active',
  now() - interval '5 days',
  '00000000-0000-0000-0000-0000000030b1',
  now() - interval '1 hour',
  'Bravo Device 001 (stale)'
);

-- Dedicated devices for the throttle tests (Group F) - kept separate from
-- the devices Group C's claim-flow assertions depend on, so repeatedly
-- failing auth against these doesn't change state Group C relies on.
insert into public.devices (id, serial_number, claim_code_hash, device_identity_hash, status)
values
  ('00000000-0000-0000-0000-0000000020f1', 'DEV-THROTTLE-001',
    extensions.crypt('claimcode-throttle-001', extensions.gen_salt('bf', 4)),
    extensions.crypt('identity-throttle-001', extensions.gen_salt('bf', 4)),
    'unclaimed'),
  ('00000000-0000-0000-0000-0000000020f2', 'DEV-THROTTLE-CLAIM-001',
    extensions.crypt('claimcode-throttle-claim-001', extensions.gen_salt('bf', 4)),
    extensions.crypt('identity-throttle-claim-001', extensions.gen_salt('bf', 4)),
    'unclaimed');

insert into public.storage_configs (org_id, provider, bucket, region, credentials_secret_ref) values
  ('00000000-0000-0000-0000-0000000000a1', 's3', 'alpha-bucket', 'us-east-1', 'vault:alpha/s3'),
  ('00000000-0000-0000-0000-0000000000b1', 'gcs', 'bravo-bucket', null, 'vault:bravo/gcs');
