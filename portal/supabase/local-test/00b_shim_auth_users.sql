-- 00b_shim_auth_users.sql
--
-- Additive to 00_supabase_shim.sql (which is left completely untouched --
-- its auth.jwt()/auth.uid() emulation is generic, not Clerk-specific, and
-- needs no changes for the Supabase-Auth-native redesign). What's new here:
-- the Clerk-based design never needed a real `auth.users` table at all (no
-- FK ever pointed at it, no trigger ever fired off it) -- devices.
-- claimed_by_user_id was a bare TEXT column, and organizations had no
-- membership table whatsoever. The redesign changes that: organization_
-- members/user_active_org/organization_invites/devices.claimed_by_user_id
-- all now carry a real `references auth.users (id)` FK
-- (0001_schema.sql), and 0008_invite_signup_trigger.sql fires an
-- `AFTER INSERT ON auth.users` trigger -- none of which can be exercised,
-- or even successfully migrated, without a real `auth.users` table to
-- point at. This file is that minimal table -- just enough columns for the
-- FKs and the trigger to work, not a full reproduction of Supabase Auth's
-- actual (much larger, platform-managed) auth.users schema.
--
-- Applied once, after 00_supabase_shim.sql and before any migration (see
-- reset_and_run.sh) -- migrations 0001+ now assume auth.users already
-- exists, exactly as they would against a real Supabase project.

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              varchar(255),
  email_confirmed_at timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists users_email_idx on auth.users (lower(email));

-- Real Supabase: only supabase_auth_admin (an internal role, not exposed to
-- PostgREST clients) has direct table privileges on auth.users; anon/
-- authenticated get none, and this project's own SECURITY DEFINER functions
-- (invite_member, handle_new_user_invites) reach it as their owner
-- (postgres), bypassing grants entirely, same as every other SECURITY
-- DEFINER function in this project reaches its own RLS-protected tables.
-- service_role is given an explicit SELECT here (harmless, and mirrors
-- Supabase's own default service_role access to the auth schema) so test
-- assertions can inspect seeded rows directly without needing superuser.
revoke all on auth.users from public, anon, authenticated;
grant select on auth.users to service_role;
