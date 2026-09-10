-- 0002_rls.sql
--
-- Row Level Security for the human/Supabase-Auth-authenticated access path.
--
-- ============================================================================
-- Sep 2026: rewritten as part of dropping Clerk entirely for native
-- Supabase Auth (see 0001_schema.sql's header for the full "why"). What
-- changes here specifically:
--
--   * Identity: a native Supabase Auth session's JWT `sub` claim IS a real
--     uuid (auth.users.id) -- unlike Clerk's `user_2abc...` ids, which is
--     exactly why the old current_clerk_user_id() helper existed (to avoid
--     auth.uid()'s implicit ::uuid cast throwing on a non-uuid Clerk id).
--     That workaround is no longer needed: auth.uid() is now exactly the
--     right primitive, and every human-identity comparison in this project
--     uses it. current_user_id() below is kept only as a thin, named
--     wrapper for stylistic symmetry with current_org_id()/current_org_role()
--     (every identity/tenancy fact this app needs has one, documented,
--     "current_*" accessor) -- it adds no behavior of its own.
--   * Org/role: Clerk's session JWT used to carry the caller's active org id
--     and role in it directly as claims (`o.id`, `o.rol`), refreshed by
--     Clerk's own session machinery on every org switch. A native Supabase
--     Auth JWT carries neither -- it's just a user identity. Both facts now
--     have to be resolved from Postgres itself: current_org_id() reads
--     public.user_active_org (falling back to the caller's earliest
--     public.organization_members row), and current_org_role() reads
--     public.organization_members for that resolved org. See
--     0001_schema.sql's header for why those two tables' DDL had to land in
--     0001 rather than a later 0007+ file, even though they're new.
--   * A signed-in user with no memberships at all (or an active-org pointer
--     that no longer matches any membership, e.g. they were removed from
--     that org) must still degrade to "see nothing", never error -- exactly
--     the same invariant the old Clerk-claims version had for "no active
--     org selected", just re-derived from tables instead of absent JWT
--     claims.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- The caller's auth.users.id, or null if unauthenticated / no JWT. A thin
-- wrapper around auth.uid() -- see the file header for why this project
-- doesn't need auth.uid()'s old Clerk-incompatibility workaround anymore,
-- and keeps this only for naming symmetry with current_org_id()/
-- current_org_role(). Not SECURITY DEFINER: auth.uid() reads the verified
-- JWT directly, no table access, nothing to bypass RLS on.
create or replace function public.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select auth.uid();
$$;

-- This project's internal organizations.id (uuid) the caller is currently
-- "in", or null if they belong to no organization at all.
--
-- Resolution order: (1) public.user_active_org, if it has a row for this
-- user AND that org is still one they're actually a member of (guards
-- against a stale pointer to an org they were since removed from -- see
-- remove_member() in 0007_org_management_functions.sql, which does try to
-- clear this proactively, but a function-level guard here means an RLS
-- policy is never wrong even if that cleanup were ever missed); (2) failing
-- that, their EARLIEST organization_members row (by created_at, org_id as a
-- deterministic tie-break) -- a sensible, stable default for a user who has
-- never explicitly switched. Returns null if they have zero memberships,
-- which every policy below must (and does) treat as "show nothing", not an
-- error.
--
-- SECURITY DEFINER + a direct, non-RLS-mediated lookup is deliberate here,
-- for the same reason it was under the old Clerk-claims design: if this
-- were SECURITY INVOKER, resolving it would depend on user_active_org's/
-- organization_members' own SELECT policies already being satisfiable,
-- which is fragile to reorder/refactor (and, for organization_members
-- specifically, its own SELECT policy is itself defined in terms of
-- is_org_member() below -- resolving current_org_id() through RLS would tie
-- these into a needlessly fragile knot). Making the resolution itself
-- definer-scoped keeps this function correct regardless of how those
-- tables' own policies evolve. It is intentionally parameterless and
-- derives everything from the caller's own verified JWT (auth.uid()), so
-- there is no injectable input and no authorization decision being
-- delegated -- it is pure claim resolution, exactly as before.
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select uao.org_id
      from public.user_active_org uao
      where uao.user_id = auth.uid()
        and uao.org_id is not null
        and exists (
          select 1
          from public.organization_members om
          where om.org_id = uao.org_id
            and om.user_id = auth.uid()
        )
    ),
    (
      select om.org_id
      from public.organization_members om
      where om.user_id = auth.uid()
      order by om.created_at asc, om.org_id asc
      limit 1
    )
  );
$$;

-- Caller's role within their current org (current_org_id(), above) -- one
-- of org_admin, device_admin, site_manager, safety_officer, viewer -- or
-- null if they have no current org.
--
-- SECURITY DEFINER for the same reason as current_org_id(): reads
-- organization_members directly rather than depending on that table's own
-- (is_org_member()-based) SELECT policy, which would otherwise make role
-- resolution circular. Unlike the old Clerk-claims version of this function
-- (a pure `auth.jwt() -> 'o' ->> 'rol'` read with no table access at all),
-- this one now genuinely needs definer privileges to see the row.
create or replace function public.current_org_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select om.role
  from public.organization_members om
  where om.org_id = public.current_org_id()
    and om.user_id = auth.uid();
$$;

-- Is the caller a member of org p_org_id (any role)? Used by policies that
-- need "any fellow member may see this", broader than current_org_id()'s
-- single active org -- e.g. organizations_select_member below, and
-- organization_members' own SELECT policy, so an org-switcher UI can list
-- every org a user belongs to, not just whichever one happens to be active.
--
-- SECURITY DEFINER for the same reason as the two functions above: a policy
-- on organization_members that queried organization_members again via a
-- plain SECURITY INVOKER subquery would be evaluating its own USING clause
-- against the subquery's rows too, which works in Postgres but is exactly
-- the kind of self-referencing-policy indirection this project's own style
-- avoids elsewhere (see 0002_rls.sql's original header on preferring
-- explicit, individually-auditable policies over cleverness) -- routing it
-- through one definer-scoped helper function keeps every call site
-- identical to how current_org_id()/current_org_role() already do this.
create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.org_id = p_org_id
      and om.user_id = auth.uid()
  );
$$;

revoke all on function public.current_user_id() from public;
revoke all on function public.current_org_role() from public;
revoke all on function public.current_org_id() from public;
revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.current_user_id() to authenticated, service_role;
grant execute on function public.current_org_role() to authenticated, service_role;
grant execute on function public.current_org_id() to authenticated, service_role;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;

comment on function public.current_org_id() is
  'Resolves the caller''s active org: user_active_org if set and still a real membership, else their earliest organization_members row, else null. SECURITY DEFINER so it does not depend on those tables'' own RLS; parameterless and auth.uid()-derived only, so this is claim resolution, not a delegated authorization decision.';
comment on function public.is_org_member(uuid) is
  'Is the caller a member of the given org, in any role? SECURITY DEFINER to avoid resolving organization_members'' own SELECT policy through itself. Broader than current_org_id() -- checks ANY membership, not just the active org.';


-- ---------------------------------------------------------------------------
-- Baseline: lock every table down, then open specific, reviewable holes.
-- ---------------------------------------------------------------------------
-- FORCE ROW LEVEL SECURITY matters little for the `authenticated`/`anon`
-- Postgres roles PostgREST actually connects as (RLS always applies to them
-- regardless of FORCE), but it also stops the table *owner* from
-- accidentally querying these tables RLS-free over a normal connection, so
-- it's included for defense in depth.
alter table public.organizations        enable row level security;
alter table public.organizations        force row level security;
alter table public.organization_members enable row level security;
alter table public.organization_members force row level security;
alter table public.user_active_org      enable row level security;
alter table public.user_active_org      force row level security;
alter table public.organization_invites enable row level security;
alter table public.organization_invites force row level security;
alter table public.sites                enable row level security;
alter table public.sites                force row level security;
alter table public.devices              enable row level security;
alter table public.devices              force row level security;
alter table public.storage_configs      enable row level security;
alter table public.storage_configs      force row level security;

-- Table privileges are the first gate, RLS is the second. `anon` gets
-- nothing on any of these tables -- the only unauthenticated write path in
-- this system is the device heartbeat, which is a SECURITY DEFINER function
-- (0004_heartbeat_function.sql), not a raw table grant.
revoke all on public.organizations        from public, anon;
revoke all on public.organization_members from public, anon;
revoke all on public.user_active_org      from public, anon;
revoke all on public.organization_invites from public, anon;
revoke all on public.sites               from public, anon;
revoke all on public.devices             from public, anon;
revoke all on public.storage_configs     from public, anon;
-- device_auth_failures is never touched directly by anon OR authenticated -
-- only by the SECURITY DEFINER functions in 0003/0004/0006 (which run as
-- the migration owner and bypass RLS) and cleanup_old_auth_failures().
revoke all on public.device_auth_failures from public, anon, authenticated;

-- service_role is granted full privileges on every table explicitly here
-- rather than left to platform-level default privileges. On a hosted
-- Supabase project service_role already gets this via a default-privileges
-- rule applied to the public schema when the project is created, so this is
-- belt-and-suspenders there -- but making it explicit means these
-- migrations are correct and self-contained on a plain/self-hosted Postgres
-- too (e.g. spun up for CI/local RLS testing, as this project's test suite
-- does), instead of silently depending on a platform behavior invisible in
-- any of these files. service_role has BYPASSRLS (granted when the role is
-- created), so RLS policies never apply to it regardless of these grants --
-- it is meant for trusted server-side/admin code paths only (support
-- tooling, scheduled jobs), never shipped to a client.
grant select, insert, update, delete on public.organizations        to service_role;
grant select, insert, update, delete on public.organization_members to service_role;
grant select, insert, update, delete on public.user_active_org      to service_role;
grant select, insert, update, delete on public.organization_invites to service_role;
grant select, insert, update, delete on public.sites                to service_role;
grant select, insert, update, delete on public.devices              to service_role;
grant select, insert, update, delete on public.storage_configs      to service_role;
grant select, insert, update, delete on public.device_auth_failures to service_role;


-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
-- Row creation now happens via create_organization()
-- (0007_org_management_functions.sql), a SECURITY DEFINER function called
-- directly by an authenticated user -- there is no external system of
-- record to sync from anymore. The one client-writable field via a plain
-- UPDATE is still `name`, for a simple "rename my org" affordance, gated to
-- org_admin -- everything else (membership, active-org, invites) goes
-- through the dedicated tables/functions below and in 0007/0008.
--
-- SELECT is intentionally broader than UPDATE: any org the caller belongs
-- to at all (is_org_member()), not just their currently-active one
-- (current_org_id()) -- an org-switcher UI needs to list every org a user
-- is a member of (with its name/plan) regardless of which one is active,
-- which the old Clerk-claims design never needed from Postgres directly
-- (Clerk's own <OrganizationSwitcher/> fetched that list from Clerk's own
-- API, not this table).

grant select on public.organizations to authenticated;
grant update (name) on public.organizations to authenticated;

create policy organizations_select_member
  on public.organizations
  for select
  to authenticated
  using (public.is_org_member(id));

create policy organizations_update_name_admin_only
  on public.organizations
  for update
  to authenticated
  using (
    id = public.current_org_id()
    and public.current_org_role() = 'org_admin'
  )
  with check (
    id = public.current_org_id()
    and public.current_org_role() = 'org_admin'
  );

-- No insert/delete policy for `authenticated` at all: default-deny.
-- Creation is create_organization()-only; deletion has no self-service path
-- yet (same "no policy is the safe default over a silent, history-
-- destroying operation" reasoning as devices' missing DELETE policy below).


-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
-- SELECT only: any fellow member can see the membership list of an org they
-- themselves belong to (a member-list UI needs this), via is_org_member()
-- rather than current_org_id() -- same reasoning as organizations' SELECT
-- policy above, an org's member list should be visible regardless of
-- whether that org happens to be the caller's currently-active one.
--
-- Deliberately NO insert/update/delete policy for `authenticated` at all --
-- see this table's comment in 0001_schema.sql. Every mutation
-- (create_organization's initial org_admin row, invite_member()'s
-- existing-user branch, the auth.users-insert trigger, change_member_role(),
-- remove_member()) is a SECURITY DEFINER function in 0007/0008, which reach
-- the table as their (RLS-bypassing) owner regardless of these policies --
-- exactly the same "authorization decision needs server-controlled logic"
-- shape as claim_device() in 0003_claim_function.sql, not a per-row
-- membership check RLS could express (role changes/removal both depend on
-- facts *other* rows in this same table, like "is there still another
-- org_admin left", which USING/WITH CHECK can't see).

grant select on public.organization_members to authenticated;

create policy organization_members_select_fellow_members
  on public.organization_members
  for select
  to authenticated
  using (public.is_org_member(org_id));


-- ---------------------------------------------------------------------------
-- user_active_org
-- ---------------------------------------------------------------------------
-- A user can read their own active-org pointer directly (useful for the
-- org-switcher UI to highlight which org is currently selected without a
-- separate RPC round-trip). No self-service write policy at all --
-- switching goes through set_active_org() (0007_org_management_functions.sql),
-- which validates the target org_id against real membership server-side
-- before writing anything; a raw client UPDATE would have to be trusted to
-- only ever set org_id to an org it actually belongs to, which is exactly
-- the kind of client-supplied-and-trusted value this project's conventions
-- (see 0003_claim_function.sql's header) never allow.

grant select on public.user_active_org to authenticated;

create policy user_active_org_select_own
  on public.user_active_org
  for select
  to authenticated
  using (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- organization_invites
-- ---------------------------------------------------------------------------
-- Scoped to the caller's currently-active org and the org_admin role only --
-- deliberately narrower than organization_members' SELECT policy above,
-- matching storage_configs' existing "org_admin only, tighter than the
-- device/site policies" precedent below: a pending invite's email address
-- is sensitive-ish (who's about to be added, and to which role) in a way a
-- plain membership row isn't, so this is not visible to every fellow
-- member, only admins managing that specific org.
--
-- No insert/update/delete policy for `authenticated` at all: creation is
-- invite_member()-only, resolution is either invite_member()'s
-- existing-user branch or the auth.users-insert trigger, and revocation is
-- revoke_invite()-only (all in 0007/0008) -- never a raw client write.

grant select on public.organization_invites to authenticated;

create policy organization_invites_select_org_admin
  on public.organization_invites
  for select
  to authenticated
  using (
    org_id = public.current_org_id()
    and public.current_org_role() = 'org_admin'
  );


-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------
-- Role matrix (deliberately explicit per-policy rather than a generic
-- "hierarchy" helper -- for a security-sensitive fleet-management system,
-- every policy should be auditable standalone without chasing indirection):
--   org_admin, site_manager : full CRUD within their own org
--   device_admin            : read-only (needs to see sites to assign devices)
--   safety_officer, viewer  : read-only

grant select, insert, update, delete on public.sites to authenticated;

create policy sites_select_own_org
  on public.sites
  for select
  to authenticated
  using (org_id = public.current_org_id());

create policy sites_insert_own_org_managers
  on public.sites
  for insert
  to authenticated
  with check (
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'site_manager')
  );

create policy sites_update_own_org_managers
  on public.sites
  for update
  to authenticated
  using (
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'site_manager')
  )
  with check (
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'site_manager')
  );

create policy sites_delete_own_org_managers
  on public.sites
  for delete
  to authenticated
  using (
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'site_manager')
  );


-- ---------------------------------------------------------------------------
-- devices (claimed rows only -- org_id is not null)
-- ---------------------------------------------------------------------------
-- Deliberately NO insert policy and NO delete policy for `authenticated`:
--   * Insert: devices only ever come into existence via provisioning
--     (0005_provisioning_function.sql / seed.sql), never via the app.
--   * Delete: decommissioning a physical device is a deliberate,
--     audited operation this schema doesn't define a self-service path for
--     yet; until it does, "no policy" (default deny) is the safe default
--     over silently allowing history-destroying deletes.
--   * Update: column-level grant below allows only display_name/site_id to
--     be touched by ordinary UPDATE statements. org_id, status,
--     claimed_at, claimed_by_user_id, serial_number, and both credential
--     hashes are NOT in the granted column list, so even a client that
--     satisfies the USING/WITH CHECK below gets a permission-denied error
--     from Postgres if it tries to set any of them -- this is enforced
--     independently of, and in addition to, the RLS policy itself.
--
-- UNCLAIMED devices (org_id is null) intentionally have NO select policy
-- here at all. A per-row "org_id is null" policy would let any
-- authenticated user list/enumerate the entire unclaimed inventory via
-- PostgREST (e.g. GET /devices?org_id=is.null) -- RLS can't distinguish
-- "looking up the one device whose code I was handed" from "listing
-- everything", because both are just SELECT * FROM devices WHERE ... under
-- the hood. The only way to read an unclaimed row is
-- lookup_device_by_claim_code(serial_number, claim_code) in
-- 0003_claim_function.sql, a SECURITY DEFINER function that requires
-- knowing both values already (they're only ever printed on the physical
-- device label) and returns nothing for a non-match instead of erroring, so
-- it can't be used to enumerate valid serials either.

-- Column-restricted SELECT: claim_code_hash and device_identity_hash are
-- never granted, even though they're bcrypt hashes and RLS would otherwise
-- let an org see its own devices' full rows. Credential hashes are exactly
-- the kind of column that should never round-trip to a client at all --
-- "it's hashed" is not a reason to hand it to every org_admin/viewer in a
-- REST response. lookup_device_by_claim_code / claim_device /
-- device_heartbeat compare against these columns server-side inside
-- SECURITY DEFINER functions; no legitimate client code path needs to read
-- them directly.
grant select (
  id, org_id, site_id, serial_number, status,
  claimed_at, claimed_by_user_id, last_seen_at, display_name, created_at
) on public.devices to authenticated;
grant update (display_name, site_id) on public.devices to authenticated;

create policy devices_select_own_org
  on public.devices
  for select
  to authenticated
  using (org_id = public.current_org_id());

create policy devices_update_own_org_admins
  on public.devices
  for update
  to authenticated
  using (
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'device_admin')
  )
  with check (
    -- org_id can't be in the SET list anyway (column grant), but repeating
    -- the org check in WITH CHECK costs nothing and keeps this policy
    -- correct even if the column grant is ever loosened by a future change.
    org_id = public.current_org_id()
    and public.current_org_role() in ('org_admin', 'device_admin')
  );


-- ---------------------------------------------------------------------------
-- storage_configs
-- ---------------------------------------------------------------------------
-- Contains a reference to where an org's device data lands and (indirectly,
-- via credentials_secret_ref) how to get write access to it. Read/write
-- restricted to org_admin only -- notably tighter than devices/sites,
-- since device_admin doesn't need to know bucket/credential *references* to
-- do device assignment, only site_manager-style metadata.

grant select, insert, update, delete on public.storage_configs to authenticated;

create policy storage_configs_select_org_admin
  on public.storage_configs
  for select
  to authenticated
  using (
    org_id = public.current_org_id()
    and public.current_org_role() = 'org_admin'
  );

create policy storage_configs_insert_org_admin
  on public.storage_configs
  for insert
  to authenticated
  with check (
    org_id = public.current_org_id()
    and public.current_org_role() = 'org_admin'
  );

create policy storage_configs_update_org_admin
  on public.storage_configs
  for update
  to authenticated
  using (
    org_id = public.current_org_id()
    and public.current_org_role() = 'org_admin'
  )
  with check (
    org_id = public.current_org_id()
    and public.current_org_role() = 'org_admin'
  );

create policy storage_configs_delete_org_admin
  on public.storage_configs
  for delete
  to authenticated
  using (
    org_id = public.current_org_id()
    and public.current_org_role() = 'org_admin'
  );
