-- 00_supabase_shim.sql
--
-- Minimal hand-built emulation of the *pieces of the Supabase platform*
-- that migrations 0001-0005 depend on, so RLS/grants/SECURITY DEFINER
-- behavior can be verified against a plain `postgres:16` Docker container --
-- no real Supabase project, no real Clerk account, no network calls.
--
-- This file is NOT a migration and is never applied to a real Supabase
-- project (Supabase already provides everything here as platform
-- infrastructure). It exists only under supabase/local-test/. See
-- supabase/README.md for how these pieces map onto the real platform.
--
-- What real Supabase provides that this reproduces:
--   1. Three Postgres roles PostgREST executes queries as: `anon`,
--      `authenticated`, `service_role` (service_role has BYPASSRLS).
--   2. An `auth` schema with a `jwt()` function that returns the verified
--      JWT's claims as jsonb, sourced from a per-request Postgres GUC
--      (`request.jwt.claims`) that PostgREST sets before running the
--      query. Real Supabase verifies the JWT signature (via Clerk's JWKS,
--      per the third-party-auth integration) *before* setting this GUC --
--      by the time SQL runs, the claims are already trustworthy. This shim
--      skips signature verification entirely (there is no real JWT here,
--      just a jsonb literal a test script sets), which is exactly why this
--      is a *local test harness*, not a security boundary -- the boundary
--      it's used to verify is the SQL/RLS layer downstream of that GUC,
--      which is identical in shape to the real platform either way.
--
-- What real Supabase provides that this deliberately does NOT reproduce
-- (out of scope for RLS testing): actual JWT signature verification, the
-- PostgREST HTTP layer itself, realtime/storage, the dashboard.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- The migration-applying role in this harness is the Docker image's default
-- superuser (`postgres`), which is a real superuser and therefore always
-- bypasses RLS (independent of FORCE ROW LEVEL SECURITY) and owns every
-- object the migrations create -- the same role shape Supabase's own
-- migration runner uses against a hosted project. This is what makes
-- SECURITY DEFINER functions like current_org_id()/claim_device()/
-- device_heartbeat() work correctly: they run as their (superuser) owner
-- regardless of the calling role's RLS policies.
grant anon, authenticated, service_role to postgres;

-- ---------------------------------------------------------------------------
-- auth schema: auth.jwt() reads the per-session GUC a test sets via
-- `SET request.jwt.claims = '...'`, exactly mirroring what PostgREST sets
-- per-request on a real Supabase project after verifying the JWT.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

-- auth.uid() reproduced for parity with the real platform. Used throughout
-- 0002_rls.sql/0007/0008 now that this project uses native Supabase Auth
-- (real uuid user ids) -- it was unusable back when this project used
-- Clerk's string-shaped user ids (auth.uid() casts the JWT sub claim to
-- uuid, which threw on Clerk's "user_2abc..." ids), but that's history now.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
