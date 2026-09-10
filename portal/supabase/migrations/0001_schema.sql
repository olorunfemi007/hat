-- 0001_schema.sql
--
-- Core tables for the hard-hat IoT portal: organizations, tenancy
-- (membership/invites/active-org), sites, devices, and per-org storage
-- configuration.
--
-- ============================================================================
-- Sep 2026: this project dropped Clerk entirely (its custom-roles feature
-- requires a paid add-on in production) in favor of Supabase's own native
-- Auth, which is free and open source. That is a bigger change than it
-- sounds: Clerk's "Organizations" product used to give this app membership,
-- roles, active-org-selection, and invites for free, synced into Postgres by
-- a webhook. None of that infrastructure exists in native Supabase Auth --
-- it has users and JWTs, nothing else -- so this migration set now BUILDS
-- tenancy from scratch: `organizations` is the system of record for itself
-- (no external mirror), and three new tables (`organization_members`,
-- `user_active_org`, `organization_invites`, all below) replace what Clerk
-- used to do. Since this project has never been deployed against a real
-- Supabase/Clerk project (nothing in production to migrate away from
-- safely), the Clerk-era tables/columns in this file were edited in place
-- rather than layered over with ALTERs in a later migration -- there is no
-- legacy data shape to preserve, and a clean history is strictly better than
-- an artificial "add text column, later ALTER to uuid" trail for something
-- that never shipped. See supabase/README.md for the full new auth-model
-- writeup and supabase/migrations/0002_rls.sql for the RLS/helper-function
-- side of this change.
-- ============================================================================
--
-- Notes on conventions used throughout this migration set:
--   * Every table's primary key is a Postgres-generated uuid (gen_random_uuid(),
--     built into core Postgres 13+, no extension required).
--   * `devices.claim_code_hash` / `devices.device_identity_hash` are the only
--     representations of those secrets that ever touch the database. Plaintext
--     only exists transiently at generation time (see 0005_provisioning_function.sql
--     and seed.sql).
--   * Every FK into Supabase Auth's own schema references `auth.users.id`
--     ONLY (the primary key). Per Supabase's own migration-hygiene guidance,
--     no other column/constraint on auth.users is safe to depend on -- it's
--     platform-managed and can change without notice.
--   * RLS, grants, and policies are deliberately NOT in this file -- see
--     0002_rls.sql. Keeping schema and access-control separate makes each
--     easier to review and to re-run independently while iterating. The new
--     tenancy tables below are schema-only for the same reason; their RLS
--     lives in 0002_rls.sql alongside the helper functions that had to be
--     rewritten anyway to resolve identity from auth.uid() + these tables
--     instead of Clerk JWT claims -- see that file's header for why the
--     table DDL had to land here (0001) rather than in a later 0007+
--     migration alongside the new SECURITY DEFINER management functions:
--     0002's rewritten current_org_id()/current_org_role() need these
--     tables to already exist the moment they're defined (Postgres
--     validates a plpgsql/sql function's body against the catalog at
--     CREATE FUNCTION time, not deferred to first call), and 0003's
--     claim_device() in turn needs those helpers to already work -- so the
--     tables can't be deferred past 0002 without breaking migration
--     application order. Everything genuinely NEW in this redesign (the
--     create_organization/invite_member/change_member_role/remove_member/
--     set_active_org functions, and the auth.users signup trigger) still
--     lands in fresh 0007+ files, exactly as instructed -- only the raw
--     table DDL these earlier files depend on had to move earlier.

-- `extensions` pre-exists on a real Supabase project; created defensively
-- here so this migration is also self-contained against a plain/local
-- Postgres (e.g. the Docker-based RLS test harness under
-- supabase/local-test/ -- see supabase/README.md).
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
-- This table IS the system of record for org existence now (no external
-- mirror) -- membership/roles live in organization_members below, not here.
-- Rows are created by create_organization() (0007_org_management_functions.sql),
-- a SECURITY DEFINER function called directly by an authenticated user, which
-- atomically creates the org row, the creator's org_admin membership, and
-- sets it as their active org. There is deliberately no INSERT policy for
-- `authenticated` on this table itself (see 0002_rls.sql) -- creation only
-- happens through that function, never a raw client INSERT.
create table if not exists public.organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  plan          text not null default 'free' check (plan in ('free', 'pro', 'enterprise')),
  created_at    timestamptz not null default now()
);

comment on table public.organizations is
  'A tenant. System of record for its own existence; membership/roles live in organization_members. Created only via create_organization() -- see 0007_org_management_functions.sql.';


-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
-- Replaces what Clerk Organizations used to track for free: who belongs to
-- which org, in what role. A user can belong to multiple organizations (the
-- app's org-switcher-shaped UI assumes this), so this is a proper many-to-
-- many join table, not a single org_id column on the user.
--
-- Deliberately no self-service INSERT/UPDATE/DELETE policy for
-- `authenticated` at all (see 0002_rls.sql) -- every mutation goes through a
-- SECURITY DEFINER function (create_organization, invite_member's
-- existing-user branch, the auth.users-insert trigger, change_member_role,
-- remove_member -- all in 0007/0008), exactly the same "credential/
-- authorization decision needs server-controlled logic, not a raw RLS-gated
-- write" reasoning already established for claim_device() in
-- 0003_claim_function.sql. A plain RLS policy could describe "a member can
-- update their OWN row" but role changes are exactly the kind of write that
-- must never be self-service (nothing stops a member from granting
-- themselves org_admin), and removal has a "don't orphan an org with zero
-- admins" invariant that a declarative USING/WITH CHECK clause can't express
-- (it would need to count OTHER rows, not just validate the one being
-- written) -- both are procedural checks, not row-membership checks.
create table if not exists public.organization_members (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('org_admin', 'device_admin', 'site_manager', 'safety_officer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index if not exists organization_members_user_id_idx on public.organization_members (user_id);

comment on table public.organization_members is
  'Tenancy: who belongs to which org, in what role. The 5 roles are identical to the earlier Clerk-custom-roles design. Mutated only via SECURITY DEFINER functions (0007/0008) -- never a raw client UPDATE/DELETE, same reasoning as claim_device().';


-- ---------------------------------------------------------------------------
-- user_active_org
-- ---------------------------------------------------------------------------
-- Clerk's session token used to carry "which org is currently active" as a
-- claim (`o.id`), refreshed automatically by Clerk's own session machinery
-- whenever a user switched orgs in its <OrganizationSwitcher/>. Native
-- Supabase Auth's JWT has no equivalent concept -- it's just a user
-- identity, nothing org-shaped -- so "active org" needs a real, durable home
-- of its own now that a user can belong to multiple orgs. This table is
-- that home: one row per user, updated via set_active_org()
-- (0007_org_management_functions.sql) whenever they switch, read by
-- current_org_id() (0002_rls.sql) on every request.
--
-- Why a table instead of trying to smuggle this into the JWT (e.g. a custom
-- access-token hook): a JWT claim is only as fresh as the token itself --
-- Supabase's own docs note access tokens are cached client-side and only
-- refreshed periodically, so a custom claim would lag behind an org switch
-- by up to that refresh interval, and updating it would require re-minting
-- a token (extra infrastructure, another moving part). A plain table row
-- updated by a SECURITY DEFINER RPC is immediately consistent (the very next
-- request sees it), requires no token machinery, and is trivial to reason
-- about/test. Why a separate table rather than a column on auth.users:
-- auth.users is Supabase-managed and explicitly documented as unsafe to
-- extend with app-owned columns -- exactly the same reason
-- organization_members only ever references auth.users.id, never adds to
-- that table directly.
--
-- Default when a user has never explicitly switched (no row here yet, or
-- their active org_id was cleared because they were removed from it): their
-- EARLIEST membership by organization_members.created_at, computed on the
-- fly by current_org_id() -- not written back as a row here, so reading
-- "what's my active org" is always a pure, side-effect-free lookup, even for
-- a user who has never called set_active_org(). org_id is nullable and set
-- to NULL (not cascaded away) when the referenced org is deleted, so this
-- row's mere existence doesn't need to track the user's other memberships --
-- current_org_id()'s fallback logic re-derives a sensible org from
-- organization_members either way.
create table if not exists public.user_active_org (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  org_id     uuid references public.organizations (id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.user_active_org is
  'One row per user: which org their session is currently "in", set via set_active_org(). Absence of a row (or a null org_id) means "no explicit choice yet" -- current_org_id() falls back to the user''s earliest organization_members row in that case, never errors.';


-- ---------------------------------------------------------------------------
-- organization_invites
-- ---------------------------------------------------------------------------
-- A person an org_admin invites by email doesn't have an auth.users row yet
-- in the common case (organic invite of someone new to the product) -- this
-- table records the *intent* ("this email, this org, this role") until a
-- matching signup shows up. Two things turn a pending row here into a real
-- organization_members row, both in 0007/0008:
--   * invite_member()'s "existing user" branch: if the invited email already
--     has an auth.users row (someone who already has a portal account
--     somewhere), the membership is created immediately and no row is
--     inserted here at all -- there's nothing to wait for.
--   * the AFTER INSERT ON auth.users trigger (0008_invite_signup_trigger.sql):
--     for the common case (brand new person), this table is exactly what it
--     resolves against once they complete signup.
-- `accepted_at`/`revoked_at` are both nullable and mutually exclusive in
-- practice (enforced by the functions that set them, not a CHECK, since
-- "at most one of two timestamps is set" is naturally a function-level
-- invariant here); a row with both null is "pending". The partial unique
-- index below prevents two simultaneous pending invites for the same
-- (org, email) -- re-inviting after a revoke/accept is fine, since the
-- earlier row no longer matches that index's predicate.
create table if not exists public.organization_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  email       text not null check (email = lower(btrim(email))),
  role        text not null check (role in ('org_admin', 'device_admin', 'site_manager', 'safety_officer', 'viewer')),
  invited_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at  timestamptz
);

create index if not exists organization_invites_org_id_idx on public.organization_invites (org_id);

-- Fast path for the signup trigger: "find every still-pending invite for
-- this email" without scanning accepted/revoked history.
create index if not exists organization_invites_pending_email_idx
  on public.organization_invites (email)
  where accepted_at is null and revoked_at is null;

-- At most one PENDING invite per (org, email) -- accepted/revoked rows are
-- history and don't count against this, so re-inviting after either is
-- always allowed.
create unique index if not exists organization_invites_pending_unique
  on public.organization_invites (org_id, email)
  where accepted_at is null and revoked_at is null;

comment on table public.organization_invites is
  'Pending/resolved invites: (org, email, role) recorded by invite_member() before the invited person has an account. Resolved into an organization_members row either immediately (email already has an auth.users row) or by the auth.users-insert trigger once they sign up -- see 0007/0008.';

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------
create table if not exists public.sites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  name        text not null,
  address     text,
  created_at  timestamptz not null default now(),

  -- Lets devices carry a composite FK (site_id, org_id) -> sites(id, org_id)
  -- below, so the database itself enforces "a device's site must belong to
  -- the device's own org" -- see the devices table comment.
  constraint sites_id_org_id_uk unique (id, org_id)
);

create index if not exists sites_org_id_idx on public.sites (org_id);

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
-- Pre-seeded inventory. A row exists (status = 'unclaimed', org_id/site_id
-- null) before any customer ever sees it; claiming flips it into an org's
-- fleet. See 0003_claim_function.sql for how the org_id/site_id/status
-- transition is authorized, and 0004_heartbeat_function.sql for how a
-- claimed device reports liveness.
create table if not exists public.devices (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid references public.organizations (id) on delete restrict,
  site_id               uuid,
  serial_number         text not null unique,
  claim_code_hash       text not null,
  device_identity_hash  text not null,
  status                text not null default 'unclaimed'
                          check (status in ('unclaimed', 'claimed', 'active', 'offline')),
  claimed_at            timestamptz,
  claimed_by_user_id    uuid references auth.users (id) on delete set null,
  last_seen_at          timestamptz,
  display_name          text,
  created_at            timestamptz not null default now(),

  -- Claim-state invariant enforced at the data layer, not just in app code:
  -- unclaimed devices have no org/claim metadata; every other status must.
  constraint devices_claim_state_chk check (
    (status = 'unclaimed' and org_id is null and claimed_at is null and claimed_by_user_id is null)
    or
    (status <> 'unclaimed' and org_id is not null)
  ),

  -- A device can only be assigned to a site once it belongs to an org.
  constraint devices_site_requires_org_chk check (site_id is null or org_id is not null),

  -- Composite FK: if site_id is set, (site_id, org_id) must match a real
  -- (sites.id, sites.org_id) pair. This is what prevents a device from ever
  -- pointing at org A while its site belongs to org B -- a plain
  -- `site_id references sites(id)` FK cannot express that on its own.
  -- MATCH SIMPLE (the default) means the constraint is skipped whenever
  -- site_id is null, which is what allows "claimed, no site yet" rows.
  constraint devices_site_org_fk foreign key (site_id, org_id)
    references public.sites (id, org_id)
    on delete restrict
);

comment on column public.devices.claim_code_hash is
  'bcrypt (pgcrypto crypt/gen_salt(''bf'')) hash of the human-facing claim code. Plaintext never stored.';
comment on column public.devices.device_identity_hash is
  'bcrypt hash of the machine-facing heartbeat credential. Distinct secret from claim_code, never equal to it.';
comment on column public.devices.claimed_by_user_id is
  'auth.users.id (a real Supabase Auth user id) of whoever claimed this device. References auth.users.id only, per Supabase''s own migration-hygiene guidance -- see this file''s header. ON DELETE SET NULL: if that user''s account is later deleted, the device stays claimed (org_id/status are untouched -- devices_claim_state_chk below never required claimed_by_user_id to be non-null), it just loses claim attribution.';

create index if not exists devices_org_id_idx on public.devices (org_id);
create index if not exists devices_site_id_idx on public.devices (site_id);
create index if not exists devices_status_idx on public.devices (status);

-- ---------------------------------------------------------------------------
-- storage_configs
-- ---------------------------------------------------------------------------
create table if not exists public.storage_configs (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations (id) on delete cascade,
  provider               text not null check (provider in ('s3', 'azure_blob', 'gcs', 'minio')),
  bucket                 text not null,
  region                 text,
  endpoint               text,
  credentials_secret_ref text not null,
  created_at             timestamptz not null default now(),

  constraint storage_configs_org_provider_bucket_uk unique (org_id, provider, bucket)
);

comment on column public.storage_configs.credentials_secret_ref is
  'Reference/name of a secret held in Supabase Vault (or equivalent), never a raw credential value.';

create index if not exists storage_configs_org_id_idx on public.storage_configs (org_id);

-- ---------------------------------------------------------------------------
-- device_auth_failures
-- ---------------------------------------------------------------------------
-- Backs the per-serial-number throttle in device_heartbeat,
-- lookup_device_by_claim_code, and claim_device (0003/0004). Logs a row on
-- every failed credential check against a given serial_number, whether or
-- not that serial actually exists, so a sustained guessing campaign against
-- one string is throttled either way. See 0006_auth_throttle.sql for the
-- cleanup function that bounds this table's growth.
create table if not exists public.device_auth_failures (
  serial_number  text not null,
  failed_at      timestamptz not null default now()
);

create index if not exists device_auth_failures_serial_time_idx
  on public.device_auth_failures (serial_number, failed_at);

comment on table public.device_auth_failures is
  'Failed-credential-check log backing the per-serial throttle in the claim/heartbeat SECURITY DEFINER functions. Never read/written by anon or authenticated directly -- only by those functions and cleanup_old_auth_failures(), all of which run as the migration owner / service_role. Needs periodic cleanup -- see 0006_auth_throttle.sql.';
