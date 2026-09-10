-- 0003_claim_function.sql
--
-- The claim path: looking up an unclaimed device by its physical
-- serial/claim-code label, and performing the actual claim.
--
-- ============================================================================
-- WHY THIS IS A SECURITY DEFINER FUNCTION, NOT A RAW RLS-GATED UPDATE
--
-- A standard "org member can update rows in their org" RLS policy is shaped
-- like: USING (org_id = current_org_id()). That works for every write in
-- this schema *except* the claim itself, because the claim is the operation
-- that gives a row its first org_id. Before the claim:
--
--   * The row's org_id is NULL. It isn't "in" any org yet, so there is no
--     org-membership fact RLS can check to decide whether this particular
--     caller is allowed to touch this particular row -- the row doesn't
--     belong to the caller's org, or to anyone else's; it belongs to no one.
--   * The authorization decision instead depends on a fact that lives in
--     the row's own hashed claim_code column: does the caller *know the
--     secret printed on this specific device's label*? That's not a
--     membership check, it's a credential check -- structurally different
--     from every other policy in this schema, and RLS's declarative
--     USING/WITH CHECK model has no way to say "let this UPDATE through iff
--     a bcrypt comparison against a column on the very row being updated
--     succeeds", because WITH CHECK is evaluated against the *proposed new
--     row*, and the client would have to be trusted to submit the correct
--     org_id/claimed_by_user_id itself for that new-row check to mean
--     anything -- there is nothing stopping a client from just setting
--     those columns directly in the same request` if they had raw UPDATE
--     access to them at all (see the column-level GRANT discussion in
--     0002_rls.sql: ordinary clients don't have UPDATE on org_id/status/
--     claimed_at/claimed_by_user_id/claim_code_hash for exactly this
--     reason).
--   * A raw client-issued UPDATE would also have to be trusted to compute
--     `claimed_by_user_id` and `claimed_at` honestly and to only match one
--     row at a time (`UPDATE devices SET org_id = ... WHERE claim_code_hash
--     = ...` invites a client sending its own org_id for literally any
--     device it can guess a code for, with no server-side check that the
--     code and the org_id came from the same authorized action).
--
-- A SECURITY DEFINER function collapses all of that into one atomic,
-- server-controlled statement: it reads the caller's identity/org/role from
-- their *verified* JWT (not from client-supplied parameters), verifies the
-- claim code against the row's own hash server-side, and only then performs
-- the UPDATE with values *it* computed -- the client-controlled inputs are
-- just (serial_number, claim_code, optional site_id/display_name), none of
-- which are trusted for anything other than "which row" and "which secret".
-- This is the same reason password-verification-then-privilege-grant is
-- never modeled as a client-writable "is_authenticated" column.
--
-- The function is owned by the migration role (postgres), which bypasses
-- RLS -- necessary here since the UPDATE has to succeed against a row with
-- org_id IS NULL, which no `authenticated`-role RLS policy would ever allow.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- lookup_device_by_claim_code
-- ---------------------------------------------------------------------------
-- Lets an authenticated user check "does this serial+code pair correspond
-- to a real, still-unclaimed device" before/without actually claiming it
-- (e.g. to show a confirmation screen). Requires knowing BOTH values, which
-- in practice means physical possession of the device's label -- there is
-- no way to enumerate valid (serial, code) pairs through this function,
-- since a non-match returns zero rows rather than an error, and no
-- parameter is optional. It exists specifically so no bulk SELECT policy on
-- unclaimed rows is ever needed (see 0002_rls.sql).
create or replace function public.lookup_device_by_claim_code(
  p_serial_number text,
  p_claim_code text
)
returns table (
  serial_number text,
  status text,
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_code_ok boolean;
  v_recent_failures int;
  -- Fixed bcrypt-shaped dummy hash (cost 12, matching claim_code_hash's real
  -- cost factor) with no corresponding real secret - see the timing note
  -- below.
  v_dummy_hash constant text := '$2a$12$cw1VFENITAs4F4X470Icnuf0oyYyJ2/X6RELIMjMdCxfaLCp2nGcK';
begin
  if public.current_user_id() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_serial_number is null or p_claim_code is null then
    raise exception 'serial_number and claim_code are required' using errcode = '22004';
  end if;

  select count(*) into v_recent_failures
  from public.device_auth_failures f
  where f.serial_number = p_serial_number
    and failed_at > now() - interval '15 minutes';

  if v_recent_failures >= 10 then
    perform extensions.crypt(p_claim_code, v_dummy_hash);
    return; -- zero rows, same as any other mismatch below
  end if;

  -- Timing-side-channel fix: look up by serial_number alone first, then
  -- ALWAYS evaluate crypt() exactly once (real hash if found, dummy if
  -- not) into its own variable before combining it with the org_id/status
  -- checks. Folding all four conditions into one WHERE clause (the
  -- original shape) lets Postgres short-circuit past crypt() the instant
  -- ANY earlier condition fails - not just on a missing row, but also on
  -- an already-claimed one - which would leak "this code is right but the
  -- device is already claimed" via timing even with content-level
  -- protections in place. Evaluating v_code_ok unconditionally, in its own
  -- statement, before any branching closes that off too.
  select d.serial_number, d.status, d.display_name, d.claim_code_hash, d.org_id
    into v_row
  from public.devices d
  where d.serial_number = p_serial_number;

  if v_row.serial_number is null then
    perform extensions.crypt(p_claim_code, v_dummy_hash);
    insert into public.device_auth_failures (serial_number) values (p_serial_number);
    return;
  end if;

  v_code_ok := (v_row.claim_code_hash = extensions.crypt(p_claim_code, v_row.claim_code_hash));

  if v_row.org_id is not null or v_row.status <> 'unclaimed' or not v_code_ok then
    insert into public.device_auth_failures (serial_number) values (p_serial_number);
    return;
  end if;

  return query select v_row.serial_number, v_row.status, v_row.display_name;
end;
$$;

comment on function public.lookup_device_by_claim_code(text, text) is
  'Checks one (serial_number, claim_code) pair against the unclaimed pool. Returns zero rows on any mismatch -- never distinguishes "wrong code" from "unknown serial" from "already claimed", to avoid leaking enumeration signal.';

revoke all on function public.lookup_device_by_claim_code(text, text) from public;
grant execute on function public.lookup_device_by_claim_code(text, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- claim_device
-- ---------------------------------------------------------------------------
-- Performs the actual claim: validates the code server-side, validates the
-- caller has an active org and an authorized role in it, validates an
-- optional target site belongs to that same org, then flips the device row
-- from unclaimed to claimed atomically.
create or replace function public.claim_device(
  p_serial_number text,
  p_claim_code text,
  p_site_id uuid default null,
  p_display_name text default null
)
returns table (
  id uuid,
  serial_number text,
  org_id uuid,
  site_id uuid,
  status text,
  display_name text,
  claimed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id  uuid;
  v_role     text;
  v_org_id   uuid;
  v_device_id uuid;
  v_row record;
  v_code_ok boolean;
  v_recent_failures int;
  -- Fixed bcrypt-shaped dummy hash (cost 12, matching claim_code_hash's real
  -- cost factor) with no corresponding real secret - see the timing note
  -- below.
  v_dummy_hash constant text := '$2a$12$cw1VFENITAs4F4X470Icnuf0oyYyJ2/X6RELIMjMdCxfaLCp2nGcK';
begin
  v_user_id := public.current_user_id();
  v_role    := public.current_org_role();
  v_org_id  := public.current_org_id();

  if v_user_id is null or v_org_id is null then
    raise exception 'authentication with an active organization is required to claim a device'
      using errcode = '28000';
  end if;

  if v_role not in ('org_admin', 'device_admin') then
    raise exception 'insufficient role to claim a device' using errcode = '42501';
  end if;

  if p_serial_number is null or p_claim_code is null then
    raise exception 'serial_number and claim_code are required' using errcode = '22004';
  end if;

  -- Optional target site must already belong to the caller's own org.
  -- Checked explicitly (rather than relying solely on the devices_site_org_fk
  -- composite FK) so a bad p_site_id fails with a clear 42501 here instead
  -- of a generic FK-violation error from deep inside the UPDATE below.
  if p_site_id is not null then
    perform 1 from public.sites s where s.id = p_site_id and s.org_id = v_org_id;
    if not found then
      raise exception 'site does not belong to your organization' using errcode = '42501';
    end if;
  end if;

  select count(*) into v_recent_failures
  from public.device_auth_failures f
  where f.serial_number = p_serial_number
    and failed_at > now() - interval '15 minutes';

  -- Why the three branches below return zero rows instead of `raise
  -- exception invalid claim code, ...`: an unhandled exception in Postgres
  -- rolls back the ENTIRE transaction back to its start - including the
  -- device_auth_failures INSERT a couple of these branches do, since that
  -- insert happens earlier in the very same transaction as the raise. A
  -- nested BEGIN/EXCEPTION block doesn't fix this either: it only protects
  -- against an error occurring *inside* that block, not against a later,
  -- separate raise elsewhere in the same outer scope. The only way for the
  -- failure-log insert to actually persist is for the function to complete
  -- successfully from Postgres's point of view - so failure is signaled by
  -- an empty result set, the same pattern lookup_device_by_claim_code
  -- already used, not by raising. This also closes a smaller secondary
  -- leak: an exception specifically for "throttled" would itself tell a
  -- prober they've been rate-limited, distinct from a wrong code - now all
  -- three failure reasons look identical (zero rows) to the caller.
  if v_recent_failures >= 10 then
    perform extensions.crypt(p_claim_code, v_dummy_hash);
    return;
  end if;

  -- Timing-side-channel fix (same reasoning as lookup_device_by_claim_code
  -- above): look up by serial_number alone, FOR UPDATE to lock the row and
  -- preserve the original race-safety property (two admins racing to claim
  -- the same device - whichever transaction gets here first holds the row
  -- lock until commit, the second blocks then sees the now-claimed state
  -- and is correctly rejected), then always evaluate crypt() exactly once
  -- before branching on org_id/status.
  select d.id, d.org_id, d.status, d.claim_code_hash into v_row
  from public.devices d
  where d.serial_number = p_serial_number
  for update;

  if v_row.id is null then
    perform extensions.crypt(p_claim_code, v_dummy_hash);
    insert into public.device_auth_failures (serial_number) values (p_serial_number);
    return;
  end if;

  v_code_ok := (v_row.claim_code_hash = extensions.crypt(p_claim_code, v_row.claim_code_hash));

  if v_row.org_id is not null or v_row.status <> 'unclaimed' or not v_code_ok then
    -- Deliberately indistinguishable, by return value, for "unknown
    -- serial", "wrong code", and "already claimed by someone else" --
    -- distinguishing them would tell an attacker which part of their guess
    -- was right.
    insert into public.device_auth_failures (serial_number) values (p_serial_number);
    return;
  end if;

  update public.devices d
  set org_id             = v_org_id,
      site_id            = p_site_id,
      status             = 'claimed',
      claimed_at         = now(),
      claimed_by_user_id = v_user_id,
      display_name       = coalesce(p_display_name, d.display_name)
  where d.id = v_row.id
  returning d.id into v_device_id;

  return query
    select d.id, d.serial_number, d.org_id, d.site_id, d.status, d.display_name, d.claimed_at
    from public.devices d
    where d.id = v_device_id;
end;
$$;

comment on function public.claim_device(text, text, uuid, text) is
  'Validates claim_code server-side and atomically flips a device from unclaimed to claimed into the caller''s active org. SECURITY DEFINER: see file header for why this cannot be a plain RLS-gated UPDATE. Failure (unknown serial, wrong code, already claimed, or throttled) returns zero rows rather than raising -- see the comment above those branches for why. Raises for genuine caller errors (no active org, insufficient role, site not in your org) instead, since those paths never insert into device_auth_failures and so have no logging-vs-rollback conflict.';

revoke all on function public.claim_device(text, text, uuid, text) from public;
grant execute on function public.claim_device(text, text, uuid, text) to authenticated, service_role;
