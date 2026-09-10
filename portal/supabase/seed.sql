-- seed.sql
--
-- Local/dev convenience seed: provisions a handful of fake unclaimed
-- devices so the claim flow has something to claim against in development.
--
-- THIS FILE IS FOR DEV/TEST DATA ONLY, and refuses to run unless explicitly
-- confirmed (see the DO block below) - a comment alone doesn't stop someone
-- from fat-fingering this against a real project via a copy-pasted
-- DATABASE_URL or the wrong project selected in the Supabase SQL editor.
--
-- `alter database postgres set app.confirm_seed = ...` (persisting the
-- confirmation so `supabase db reset`'s automatic seed step keeps working
-- without confirming on every run) is NOT an option here, confirmed by
-- actually running it against a real local Supabase CLI stack: Postgres
-- only allows ALTER DATABASE/ROLE ... SET of an unrecognized custom GUC
-- class (like `app.*`) to an actual superuser, and Supabase's `postgres`
-- role -- local CLI stack included, matching the hosted platform on
-- purpose -- deliberately is not one (see 0008_invite_signup_trigger.sql's
-- header for the same "postgres isn't really superuser here" lesson,
-- discovered the same way). `[db.seed]` is therefore left disabled in
-- `config.toml` for this project -- `supabase start`/`db reset` apply
-- migrations only, and seeding is always the one-off manual form below, in
-- the same session as the actual INSERTs:
--   set app.confirm_seed = 'yes-seed-this-database';
-- In one shot, e.g. against the local CLI stack (never a remote project's
-- connection string):
--   docker exec -i supabase_db_<project_id> psql -U postgres -d postgres \
--     -c "set app.confirm_seed = 'yes-seed-this-database';" -f - < supabase/seed.sql
--
-- For a real hardware batch, call public.provision_devices() directly
-- (see the worked example at the bottom of this file) with the
-- batch's real serial numbers, from a one-off operator session, and capture
-- its output immediately: the plaintext claim_code/device_identity_secret
-- values are returned exactly once and cannot be recovered from the
-- database afterward (only their bcrypt hashes are stored).
--
-- Why this is SQL rather than a Node/Python script: the actual
-- secret-generation + hashing + insert is already implemented once, in
-- Postgres, as public.provision_devices() (0005_provisioning_function.sql)
-- -- that's the piece that has to be correct and is worth the SECURITY
-- DEFINER scrutiny. A seed script's only remaining job is "call it with
-- some serial numbers and show the result", which SQL does natively via
-- RETURNS TABLE / \gset-style output, with zero added dependencies (no
-- npm/pip package needs access to a service-role credential just to print
-- five rows). If a future non-technical provisioning workflow needs a nicer
-- UI (e.g. a "generate batch + download label PDFs" admin page), that
-- should be a thin wrapper that calls this same SQL function via the
-- service_role key -- not a second implementation of the hashing logic.

-- Technical safeguard, not just the comment above: this file refuses to run
-- at all unless the caller has explicitly opted in for this session, so it
-- can't be fat-fingered against a real database by e.g. an IDE's "run this
-- file" button or a copy-pasted CI step. There's no way to detect "is this
-- production" from inside Postgres itself (a project's plan/environment is
-- Supabase platform metadata, not visible to SQL) - so this asks for
-- explicit, low-probability-of-being-accidental confirmation instead:
--   set app.confirm_seed = 'yes-seed-this-database';
-- immediately before running this file.
do $$
begin
  if coalesce(current_setting('app.confirm_seed', true), '') <> 'yes-seed-this-database' then
    raise exception
      'refusing to run seed.sql: set app.confirm_seed = ''yes-seed-this-database'' first (see this file''s header). This is dev/test-only seed data.'
      using errcode = '55000';
  end if;
end;
$$;

select 'Seeding dev devices -- copy the plaintext columns below now, they will not be shown again.' as notice;

select *
from public.provision_devices(array[
  'DEV-HARDHAT-0001',
  'DEV-HARDHAT-0002',
  'DEV-HARDHAT-0003',
  'DEV-HARDHAT-0004',
  'DEV-HARDHAT-0005'
]);

-- ---------------------------------------------------------------------------
-- Worked example for a REAL hardware batch (not executed by this file --
-- copy/adapt into your own one-off operator session):
--
--   select * from public.provision_devices(array[
--     'PI-SN-4C1A9F2B',
--     'PI-SN-4C1A9F2C',
--     'PI-SN-4C1A9F2D'
--   ]);
--
-- Capture the result set (psql \copy, or your SQL client's export) into
-- whatever produces the physical labels / flashes the device image, then
-- discard the plaintext from wherever you ran this. Only run this against
-- production with the service_role key from a trusted operator machine,
-- never from client code or a checked-in script.
-- ---------------------------------------------------------------------------
