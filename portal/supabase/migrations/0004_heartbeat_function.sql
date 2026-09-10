-- 0004_heartbeat_function.sql
--
-- The device phone-home path: the Pi's wifi-onboarding-adjacent agent POSTs
-- here once it has confirmed real internet connectivity, authenticated by
-- its own device_identity_secret -- a credential that is NOT a Supabase
-- Auth session and never will be (the device is not a Supabase Auth user
-- or organization member; it has no human behind it at the moment it calls
-- this). This path was never Clerk-dependent to begin with, so dropping
-- Clerk (see 0001_schema.sql's header) changes nothing about the logic
-- below -- only the wording here is updated, for accuracy.
--
-- ============================================================================
-- WHY THIS IS A SEPARATE SECURITY DEFINER FUNCTION, GRANTED TO `anon`
--
-- Every policy in 0002_rls.sql assumes the caller has a real Supabase Auth
-- session and arrives as the Postgres `authenticated` role with a real,
-- verifiable JWT (auth.uid() resolvable). A device calling home has none of
-- that -- it holds one static secret (device_identity_hash's plaintext
-- counterpart) and nothing else. Two ways to shape this were considered:
--
--   1. Give the device a real Supabase/Postgres credential with table
--      grants, gated by its own RLS policy (e.g. "a row is writable by
--      whoever presents its device_identity"). Rejected: RLS policies are
--      evaluated against the session's role/claims, and there is no
--      Supabase-native session type for "authenticated as one specific
--      device row" -- you'd end up either minting a service_role-equivalent
--      credential per device (unmanageable key sprawl, and service_role
--      bypasses RLS anyway so it buys no isolation) or smuggling the device
--      secret into a custom JWT claim, which reintroduces JWT
--      issuance/signing infrastructure this project deliberately avoids by
--      using Supabase Auth for the human side only.
--   2. A SECURITY DEFINER function taking (serial_number,
--      device_identity_secret) that authenticates the request *inside the
--      function body* and touches exactly one row. This is what's
--      implemented below. It's the same shape as claim_device in
--      0003_claim_function.sql for the same underlying reason: the
--      authorization decision depends on a secret compared against a
--      column on the row being written, not on session-level
--      role/membership claims, so it can't be expressed as an RLS
--      USING/WITH CHECK clause at all -- it has to be procedural.
--
-- The function is granted to `anon` only (not `authenticated`, not
-- `public`): the device calls this over the REST API using the project's
-- anon/publishable key, the same way any unauthenticated client would, but
-- `anon` has zero table grants on `devices` (0002_rls.sql revokes all from
-- anon) -- EXECUTE on this one function is the *entire* blast radius of the
-- anon key as far as this table is concerned. A leaked anon key alone still
-- can't read or write any device row: doing so additionally requires a
-- valid (serial_number, device_identity_secret) pair, which is exactly the
-- credential this endpoint exists to check. Conversely `authenticated`
-- (real signed-in humans) is deliberately NOT granted this function -- heartbeat
-- semantics belong to devices only, and keeping the grant sets disjoint
-- (anon vs. authenticated are sibling roles, neither inherits the other's
-- grants) makes the two auth paths impossible to cross by accident.
-- ============================================================================

create or replace function public.device_heartbeat(
  p_serial_number text,
  p_device_identity_secret text
)
returns table (
  serial_number text,
  status text,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_hash text;
  v_code_ok boolean;
  v_recent_failures int;
  -- Fixed bcrypt-shaped dummy hash (cost 10, matching device_identity_hash's
  -- real cost factor), with no corresponding real secret. Compared against
  -- on every path that doesn't have a real hash to check (nonexistent
  -- serial, or throttled), so those paths pay the identical crypt() cost as
  -- "serial exists, wrong secret" -- see the timing-side-channel note below.
  v_dummy_hash constant text := '$2a$10$jVLZEJOjyRtwFOTwqL0dEuJCiZAxBmM9rf5LrgYr5yPGFXFIsvliG';
begin
  if p_serial_number is null or p_device_identity_secret is null then
    raise exception 'serial_number and device_identity_secret are required' using errcode = '22004';
  end if;

  -- Throttle: block sustained credential-guessing against one serial
  -- number, whether or not that serial exists. Still pays the dummy crypt()
  -- cost so the throttle check itself introduces no new timing signal.
  select count(*) into v_recent_failures
  from public.device_auth_failures f
  where f.serial_number = p_serial_number
    and failed_at > now() - interval '15 minutes';

  if v_recent_failures >= 10 then
    perform extensions.crypt(p_device_identity_secret, v_dummy_hash);
    -- Zero rows, not an exception -- see the "why zero rows, not raise"
    -- note below. Also deliberately indistinguishable from "wrong secret":
    -- an exception here specifically for throttling would itself leak "you
    -- have been rate-limited" to a prober, which is its own signal worth
    -- not giving away.
    return;
  end if;

  -- Timing-side-channel fix: look up the row by serial_number ALONE first
  -- (a plain index lookup, same cost whether or not the row exists), then
  -- ALWAYS evaluate crypt() exactly once afterward -- against the real hash
  -- if found, against v_dummy_hash if not -- so "no such serial" and
  -- "serial exists, wrong secret" are computationally indistinguishable by
  -- response time. The original version put the hash comparison inside the
  -- UPDATE's own WHERE clause, which let Postgres short-circuit past
  -- crypt() entirely on a unique-index miss - fast on a nonexistent serial,
  -- slow (bcrypt) on an existing one - leaking existence via timing even
  -- though the *content* of the response never distinguished the two cases.
  select d.id, d.device_identity_hash into v_id, v_hash
  from public.devices d
  where d.serial_number = p_serial_number;

  -- Why zero rows, not `raise exception`, for the two failure branches
  -- below: an unhandled exception in Postgres rolls back the ENTIRE
  -- transaction back to its start - including the device_auth_failures
  -- INSERT this function just did, since that insert happened earlier in
  -- the very same transaction as the raise. A nested BEGIN/EXCEPTION block
  -- doesn't fix this either: it only protects against an error occurring
  -- *inside* that block, not against a later, separate raise elsewhere in
  -- the same outer scope. The only way for the failure-log insert to
  -- actually persist is for the function to complete successfully from
  -- Postgres's point of view - so failure is signaled by an empty result
  -- set (this RETURNS TABLE function returning zero rows), the same
  -- pattern lookup_device_by_claim_code already used, not by raising.
  if v_hash is null then
    perform extensions.crypt(p_device_identity_secret, v_dummy_hash);
    insert into public.device_auth_failures (serial_number) values (p_serial_number);
    return;
  end if;

  v_code_ok := (v_hash = extensions.crypt(p_device_identity_secret, v_hash));

  if not v_code_ok then
    insert into public.device_auth_failures (serial_number) values (p_serial_number);
    return;
  end if;

  -- Status transition: an unclaimed device that phones home (possible if
  -- it has real connectivity before anyone has claimed it yet) stays
  -- unclaimed -- last_seen_at is still recorded, which is useful
  -- provisioning telemetry, but there is no org to be "active" in. Any
  -- claimed/active/offline device transitions to active: this is
  -- deliberately the only status this function can ever set it to
  -- (offline is decided by absence of heartbeats, see
  -- mark_stale_devices_offline below, not asserted by the device itself).
  update public.devices d
  set last_seen_at = now(),
      status = case when d.status = 'unclaimed' then 'unclaimed' else 'active' end
  where d.id = v_id;

  return query
    select d.serial_number, d.status, d.last_seen_at
    from public.devices d
    where d.id = v_id;
end;
$$;

comment on function public.device_heartbeat(text, text) is
  'Device phone-home: verifies device_identity_secret against device_identity_hash server-side and updates last_seen_at/status for exactly that one row. Granted to anon only -- see file header. Failure (unknown serial, wrong secret, or throttled) returns zero rows rather than raising -- see the comment above the failure branches for why.';

revoke all on function public.device_heartbeat(text, text) from public;
grant execute on function public.device_heartbeat(text, text) to anon, service_role;


-- ---------------------------------------------------------------------------
-- mark_stale_devices_offline (bonus: completes the status lifecycle)
-- ---------------------------------------------------------------------------
-- 'offline' is a valid devices.status but nothing above ever sets it --
-- device_heartbeat only ever asserts liveness, never absence of it (a
-- device that has lost connectivity is, definitionally, not calling this
-- endpoint to tell you so). Something has to sweep for staleness on a
-- timer instead. This is that sweep, exposed as a callable function rather
-- than baked into a specific scheduler so it can be driven by whatever this
-- project ends up using for cron (pg_cron, a Vercel cron hitting an API
-- route with the service_role key, etc.) without a further migration.
--
-- service_role-only: this is an operational/system job, not something any
-- org member or device should ever call directly.
create or replace function public.mark_stale_devices_offline(
  p_stale_after interval default '10 minutes'
)
returns setof public.devices
language sql
security definer
set search_path = ''
as $$
  update public.devices d
  set status = 'offline'
  where d.status = 'active'
    and d.last_seen_at < now() - p_stale_after
  returning d.*;
$$;

comment on function public.mark_stale_devices_offline(interval) is
  'Sweeps active devices whose last_seen_at has gone stale to status=offline. Intended to be invoked on a schedule (pg_cron or external) by service_role, never by a client.';

revoke all on function public.mark_stale_devices_offline(interval) from public;
grant execute on function public.mark_stale_devices_offline(interval) to service_role;
