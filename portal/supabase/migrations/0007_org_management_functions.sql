-- 0007_org_management_functions.sql
--
-- The SECURITY DEFINER functions that replace what Clerk's Organizations
-- product used to do for free: creating an org, inviting someone by email,
-- changing a member's role, removing a member, and switching which org is
-- "active". See 0001_schema.sql's header for why the underlying tables
-- (organization_members, user_active_org, organization_invites) had to
-- land in 0001/0002 instead of here -- everything in *this* file is
-- genuinely new behavior with no forward-reference problem, so it lands at
-- 0007 as instructed.
--
-- ============================================================================
-- WHY EVERY ONE OF THESE IS A SECURITY DEFINER FUNCTION, NOT A RAW RLS-GATED
-- WRITE -- same family of reasoning as claim_device() in
-- 0003_claim_function.sql, restated per-function below, but the common
-- thread is: each of these needs to check a fact that ISN'T "does the
-- proposed new row belong to my org" (which USING/WITH CHECK can express
-- fine, and is exactly what 0002_rls.sql's plain policies already cover for
-- sites/devices/storage_configs). Instead:
--
--   * create_organization: the row being inserted (a brand new org) has no
--     org_id-based membership fact yet to check -- same "this operation
--     gives something its first identity" shape as claim_device flipping a
--     device from unclaimed to claimed. It also has to atomically create a
--     SECOND row (the creator's own org_admin membership) and update a
--     THIRD table (their active org) in the same transaction as the first
--     -- there is no single-table RLS policy that spans three tables.
--   * invite_member / revoke_invite: authorization depends on the caller's
--     role in a CALLER-SPECIFIED org (the org being managed), which must be
--     checked against organization_members directly, never trusted from a
--     client-supplied "I'm an admin" flag, and the existing-user-vs-new-
--     invite branch requires querying auth.users -- something an RLS policy
--     on organization_invites has no way to do.
--   * change_member_role / remove_member: both must enforce "the org still
--     has at least one org_admin after this change" -- a fact about OTHER
--     rows in organization_members, not the one row being written. RLS's
--     USING/WITH CHECK can only see the row being read/written, never count
--     siblings, so this invariant is structurally impossible to express as
--     a policy no matter how it's phrased.
--   * set_active_org: must verify the caller is actually a member of the
--     org_id they're asking to switch to, server-side, before writing --
--     never trusting that a client-supplied org_id is one they belong to.
--
-- Every function below reads the caller's identity from auth.uid() (their
-- own already-verified JWT), never from a client-supplied "user_id"
-- parameter, and re-derives org/role from organization_members itself for
-- whatever org_id the caller names -- never from current_org_id()/
-- current_org_role() (which only ever reflect the caller's currently
-- ACTIVE org) when the operation targets a caller-specified org_id that may
-- or may not be the active one (e.g. managing a second org while browsing
-- devices in your first). This mirrors claim_device()'s own rule: nothing
-- client-supplied is trusted for "who" or "what role" without a
-- server-side check against a table first.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- create_organization
-- ---------------------------------------------------------------------------
-- Creates a brand new org, makes the caller its org_admin, and makes it
-- their active org -- atomically, in one function call, so there's no
-- window where the org exists without an admin or where the caller's active
-- org points somewhere stale.
create or replace function public.create_organization(
  p_name text
)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_name text;
  v_org public.organizations;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  v_name := btrim(p_name);
  if v_name is null or v_name = '' then
    raise exception 'organization name is required' using errcode = '22004';
  end if;

  insert into public.organizations (name)
  values (v_name)
  returning * into v_org;

  insert into public.organization_members (org_id, user_id, role)
  values (v_org.id, v_user_id, 'org_admin');

  insert into public.user_active_org (user_id, org_id)
  values (v_user_id, v_org.id)
  on conflict (user_id) do update set org_id = excluded.org_id, updated_at = now();

  return v_org;
end;
$$;

comment on function public.create_organization(text) is
  'Creates an org, makes the caller its org_admin, and sets it as their active org, atomically. SECURITY DEFINER: organizations/organization_members/user_active_org all deny direct client INSERT (see 0002_rls.sql) -- this is the only path to any of the three.';

revoke all on function public.create_organization(text) from public;
grant execute on function public.create_organization(text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- invite_member
-- ---------------------------------------------------------------------------
-- Called by an org_admin to add someone to their org by email. Two
-- outcomes, both decided server-side:
--   * The email already belongs to a real auth.users account (someone who
--     already has a portal login, just not in THIS org yet) -- add them as
--     a member immediately. There's nothing to wait for, and no invite
--     email is needed (per the researched Admin API behavior:
--     inviteUserByEmail() itself would just error "user already
--     registered" for this case anyway -- deciding it here, server-side,
--     means the Next.js layer never has to branch on that error string).
--   * The email has no existing account -- record a pending invite row.
--     The Next.js layer (which owns the actual email-sending -- see this
--     function's comment on why that's not done in SQL) is expected to
--     call supabase.auth.admin.inviteUserByEmail() right after this
--     returns outcome = 'invited', using the returned email/role. Once
--     that person completes signup, the AFTER INSERT ON auth.users trigger
--     in 0008_invite_signup_trigger.sql turns this row into a real
--     membership automatically.
--
-- Deliberately does NOT call the Auth Admin API itself -- inviteUserByEmail
-- is JS-SDK-only and requires the service-role/secret key, which has no
-- meaning inside a Postgres function; sending the actual email is entirely
-- the Next.js server-side layer's job. This function's only responsibility
-- is the authorization decision and the durable Postgres-side record of
-- intent.
create or replace function public.invite_member(
  p_org_id uuid,
  p_email text,
  p_role text
)
returns table (
  outcome text,
  invite_id uuid,
  user_id uuid,
  email text,
  role text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_role text;
  v_email text;
  v_existing_user_id uuid;
  v_invite_id uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_org_id is null then
    raise exception 'org_id is required' using errcode = '22004';
  end if;

  -- Server-side authorization check against the CALLER-SPECIFIED org --
  -- never trusts current_org_role()/current_org_id(), which only reflect
  -- whichever org happens to be the caller's currently active one. See
  -- this file's header.
  select om.role into v_caller_role
  from public.organization_members om
  where om.org_id = p_org_id
    and om.user_id = v_caller;

  if v_caller_role is distinct from 'org_admin' then
    raise exception 'only an org admin can invite members' using errcode = '42501';
  end if;

  if p_role not in ('org_admin', 'device_admin', 'site_manager', 'safety_officer', 'viewer') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  v_email := lower(btrim(p_email));
  if v_email is null or v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'a valid email is required' using errcode = '22004';
  end if;

  -- auth.users.id is the only column of auth.users this project ever
  -- treats as stable (see 0001_schema.sql's header) -- email is read here
  -- for lookup only, never stored/joined elsewhere off this function's own
  -- result. `order by ... limit 1` defensively avoids assuming email
  -- uniqueness is guaranteed at the database level.
  --
  -- email_confirmed_at is not null is not a nicety here, it's the actual
  -- security check: anyone can create an UNCONFIRMED auth.users row for any
  -- email via ordinary self-serve signup, including an email they don't
  -- control. Without this filter, an attacker could pre-squat the email
  -- address an org_admin is about to invite, and this branch would grant
  -- THAT attacker-controlled account immediate org membership the moment
  -- the real invite happens -- an account-takeover-by-email-squatting
  -- vector, not a theoretical one. Treating an unconfirmed row as "no real
  -- account yet" and falling through to the pending-invite path below is
  -- the correct, safe behavior: the eventual real owner still resolves the
  -- invite normally once THEY confirm (0008_invite_signup_trigger.sql).
  select u.id into v_existing_user_id
  from auth.users u
  where lower(u.email) = v_email
    and u.email_confirmed_at is not null
  order by u.created_at asc
  limit 1;

  if v_existing_user_id is not null then
    perform 1 from public.organization_members om
      where om.org_id = p_org_id and om.user_id = v_existing_user_id;
    if found then
      raise exception 'this person is already a member of this organization' using errcode = '23505';
    end if;

    insert into public.organization_members (org_id, user_id, role)
    values (p_org_id, v_existing_user_id, p_role);

    return query select 'added_existing_member'::text, null::uuid, v_existing_user_id, v_email, p_role;
    return;
  end if;

  perform 1 from public.organization_invites oi
    where oi.org_id = p_org_id
      and oi.email = v_email
      and oi.accepted_at is null
      and oi.revoked_at is null;
  if found then
    raise exception 'an invite is already pending for this email in this organization' using errcode = '23505';
  end if;

  -- Known, accepted narrow race (not a security issue, a UX rough edge):
  -- if this SELECT-then-INSERT runs concurrently with someone completing
  -- signup for this exact email whose confirmation lands between this
  -- function's existing-user check above and this INSERT committing, the
  -- signup trigger (0008) won't see this row yet (MVCC: it isn't committed
  -- until this function returns) and correctly no-ops as "no matching
  -- invite" -- the trigger only fires once, at that confirmation moment, so
  -- it won't retroactively pick this row up later either. The invite row
  -- itself is still created and visible to the org_admin's invite list, so
  -- the practical impact is "re-invite them" rather than lost data or a
  -- security gap. A periodic reconcile function (same callable-on-a-schedule
  -- shape as cleanup_old_auth_failures/mark_stale_devices_offline) sweeping
  -- pending invites against confirmed auth.users rows would close this
  -- fully if it becomes a real issue in practice -- not built here as
  -- disproportionate to a millisecond-scale race with a cheap fallback.
  insert into public.organization_invites (org_id, email, role, invited_by)
  values (p_org_id, v_email, p_role, v_caller)
  returning id into v_invite_id;

  return query select 'invited'::text, v_invite_id, null::uuid, v_email, p_role;
end;
$$;

comment on function public.invite_member(uuid, text, text) is
  'Org-admin-only. Adds an existing auth.users account to the org immediately, or records a pending organization_invites row for a not-yet-registered email. Never sends the invite email itself -- see comment for why that''s the Next.js layer''s job.';

revoke all on function public.invite_member(uuid, text, text) from public;
grant execute on function public.invite_member(uuid, text, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- revoke_invite
-- ---------------------------------------------------------------------------
-- Lets an org_admin cancel a pending invite (e.g. invited the wrong email).
-- Not explicitly requested by name in the original design, but a direct,
-- minimal completion of invite_member()'s lifecycle -- the
-- organization_invites SELECT policy already exposes pending invites to
-- org_admins (0002_rls.sql), so without this there would be no way to act
-- on what that listing shows.
create or replace function public.revoke_invite(
  p_invite_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_org_id uuid;
  v_caller_role text;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select oi.org_id into v_org_id
  from public.organization_invites oi
  where oi.id = p_invite_id
    and oi.accepted_at is null
    and oi.revoked_at is null;

  if v_org_id is null then
    raise exception 'invite not found or already resolved' using errcode = 'P0002';
  end if;

  select om.role into v_caller_role
  from public.organization_members om
  where om.org_id = v_org_id
    and om.user_id = v_caller;

  if v_caller_role is distinct from 'org_admin' then
    raise exception 'only an org admin can revoke an invite' using errcode = '42501';
  end if;

  update public.organization_invites
  set revoked_at = now()
  where id = p_invite_id;
end;
$$;

comment on function public.revoke_invite(uuid) is
  'Org-admin-only. Cancels a still-pending invite. No-op-safe against races: if the invite was already accepted/revoked by the time this runs, it raises a clear "already resolved" error rather than silently doing nothing.';

revoke all on function public.revoke_invite(uuid) from public;
grant execute on function public.revoke_invite(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- change_member_role
-- ---------------------------------------------------------------------------
create or replace function public.change_member_role(
  p_org_id uuid,
  p_user_id uuid,
  p_new_role text
)
returns public.organization_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_role text;
  v_target_exists boolean;
  v_remaining_admins int;
  v_row public.organization_members;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_org_id is null or p_user_id is null then
    raise exception 'org_id and user_id are required' using errcode = '22004';
  end if;

  if p_new_role not in ('org_admin', 'device_admin', 'site_manager', 'safety_officer', 'viewer') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  select om.role into v_caller_role
  from public.organization_members om
  where om.org_id = p_org_id
    and om.user_id = v_caller;

  if v_caller_role is distinct from 'org_admin' then
    raise exception 'only an org admin can change a member''s role' using errcode = '42501';
  end if;

  perform 1 from public.organization_members om
    where om.org_id = p_org_id and om.user_id = p_user_id;
  v_target_exists := found;
  if not v_target_exists then
    raise exception 'user is not a member of this organization' using errcode = 'P0002';
  end if;

  -- "Last admin" guard: count org_admins in this org EXCLUDING the target
  -- row -- this is what "would remain after this change" means regardless
  -- of the target's current role, and it's a fact about OTHER rows this
  -- function has to check directly, exactly why this can't be an RLS
  -- policy (see file header).
  if p_new_role <> 'org_admin' then
    -- FOR UPDATE (via the subquery -- Postgres rejects FOR UPDATE combined
    -- directly with an aggregate like count(*)): without this, two
    -- concurrent calls (e.g. demoting two different admins at once) can
    -- each count before either commits, both see "1 other admin remains",
    -- and both proceed -- leaving zero admins once both transactions
    -- commit. Locking this org's admin rows for the duration of the
    -- check-then-act serializes concurrent callers targeting the same org,
    -- so the second one blocks until the first commits and then sees its
    -- effect.
    select count(*) into v_remaining_admins
    from (
      select 1
      from public.organization_members om
      where om.org_id = p_org_id
        and om.role = 'org_admin'
        and om.user_id <> p_user_id
      for update
    ) locked;

    if v_remaining_admins = 0 then
      raise exception 'cannot change role: this organization would have no org_admin left' using errcode = '42501';
    end if;
  end if;

  update public.organization_members
  set role = p_new_role
  where org_id = p_org_id and user_id = p_user_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.change_member_role(uuid, uuid, text) is
  'Org-admin-only. Changes a fellow member''s role, refusing any change that would leave the org with zero org_admins. SECURITY DEFINER: organization_members has no client UPDATE policy at all (see 0002_rls.sql) -- this is the only path.';

revoke all on function public.change_member_role(uuid, uuid, text) from public;
grant execute on function public.change_member_role(uuid, uuid, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- remove_member
-- ---------------------------------------------------------------------------
-- Two callers are authorized: an org_admin removing anyone, or a member
-- removing themselves ("leave org" -- a natural, low-risk completion of
-- this function's purpose; self-removal can't be a privilege escalation by
-- definition). Either way, the same "don't orphan the org" guard as
-- change_member_role applies.
create or replace function public.remove_member(
  p_org_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_caller_role text;
  v_target_role text;
  v_remaining_admins int;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_org_id is null or p_user_id is null then
    raise exception 'org_id and user_id are required' using errcode = '22004';
  end if;

  select om.role into v_caller_role
  from public.organization_members om
  where om.org_id = p_org_id
    and om.user_id = v_caller;

  if v_caller_role is null then
    raise exception 'you are not a member of this organization' using errcode = '42501';
  end if;

  if v_caller_role is distinct from 'org_admin' and v_caller <> p_user_id then
    raise exception 'only an org admin can remove another member' using errcode = '42501';
  end if;

  select om.role into v_target_role
  from public.organization_members om
  where om.org_id = p_org_id
    and om.user_id = p_user_id;

  if v_target_role is null then
    raise exception 'user is not a member of this organization' using errcode = 'P0002';
  end if;

  if v_target_role = 'org_admin' then
    -- Same concurrent-demotion race as change_member_role() above, same
    -- fix: lock via the subquery, then count (Postgres rejects FOR UPDATE
    -- combined directly with an aggregate).
    select count(*) into v_remaining_admins
    from (
      select 1
      from public.organization_members om
      where om.org_id = p_org_id
        and om.role = 'org_admin'
        and om.user_id <> p_user_id
      for update
    ) locked;

    if v_remaining_admins = 0 then
      raise exception 'cannot remove the last org_admin of this organization' using errcode = '42501';
    end if;
  end if;

  delete from public.organization_members
  where org_id = p_org_id and user_id = p_user_id;

  -- If the removed member's active org pointed at this org, clear it so
  -- current_org_id() correctly falls back to another membership (or null)
  -- on their next request, instead of pointing at an org they're no longer
  -- in. current_org_id() also guards against this independently (it
  -- re-checks membership itself), so this is belt-and-suspenders, not the
  -- only thing standing between a removed member and stale access.
  update public.user_active_org
  set org_id = null, updated_at = now()
  where user_id = p_user_id and org_id = p_org_id;
end;
$$;

comment on function public.remove_member(uuid, uuid) is
  'Org-admin removing anyone, or any member removing themselves ("leave org"), refusing any removal that would leave the org with zero org_admins. SECURITY DEFINER: organization_members has no client DELETE policy at all (see 0002_rls.sql) -- this is the only path.';

revoke all on function public.remove_member(uuid, uuid) from public;
grant execute on function public.remove_member(uuid, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- set_active_org
-- ---------------------------------------------------------------------------
-- Switches which org current_org_id()/current_org_role() resolve to for the
-- caller. The entire point of this function is the one check inside it:
-- p_org_id is never trusted just because the client sent it -- it must
-- already be a real organization_members row for this caller.
create or replace function public.set_active_org(
  p_org_id uuid
)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
  v_org public.organizations;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_org_id is null then
    raise exception 'org_id is required' using errcode = '22004';
  end if;

  perform 1 from public.organization_members om
    where om.org_id = p_org_id and om.user_id = v_caller;
  if not found then
    raise exception 'you are not a member of this organization' using errcode = '42501';
  end if;

  insert into public.user_active_org (user_id, org_id)
  values (v_caller, p_org_id)
  on conflict (user_id) do update set org_id = excluded.org_id, updated_at = now();

  select * into v_org from public.organizations where id = p_org_id;
  return v_org;
end;
$$;

comment on function public.set_active_org(uuid) is
  'Switches the caller''s active org after verifying real membership server-side -- never trusts a client-supplied org_id without that check. Persists in user_active_org (a real row, not a session/JWT claim), so it survives across sessions/requests unlike Clerk''s old session-token-embedded active org.';

revoke all on function public.set_active_org(uuid) from public;
grant execute on function public.set_active_org(uuid) to authenticated, service_role;
