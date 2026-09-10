-- 0008_invite_signup_trigger.sql
--
-- Resolves pending organization_invites into real organization_members rows
-- automatically when a matching person signs up -- the other half of
-- invite_member()'s "new person" branch in 0007_org_management_functions.sql.
--
-- ============================================================================
-- WHY AN AFTER INSERT ON auth.users TRIGGER, AND ITS EXACT SHAPE (per
-- Supabase's own current documented pattern -- see "User Management" in the
-- Supabase docs, and GitHub Discussions #21828/#3614/#38887 for the gotchas
-- below, all researched against current docs, Sep 2026):
--
--   * A new auth.users row appears at TWO different moments depending on
--     path: (a) organic self-serve signup -- the row appears only once
--     someone actually signs up; (b) admin-invited via
--     supabase.auth.admin.inviteUserByEmail() (called from the Next.js
--     layer right after invite_member() returns outcome='invited') -- that
--     call inserts the auth.users row SYNCHRONOUSLY AND IMMEDIATELY,
--     unconfirmed, before the invited person has done anything at all. An
--     AFTER INSERT trigger fires correctly for both, which is exactly why
--     it's the right mechanism here rather than something wired only into
--     invite_member() itself (that function runs BEFORE the invited
--     person's auth.users row exists at all, in the common "new person"
--     case -- there is nothing yet to link at that point).
--   * auth.users INSERTs are executed internally as the `supabase_auth_admin`
--     role, which has no privileges outside the `auth` schema. Without
--     SECURITY DEFINER, this trigger function would fail with "permission
--     denied for schema public" the instant it tried to touch
--     organization_members/organization_invites.
--   * The function must be owned by `postgres` (true of every function in
--     this migration set, since migrations run as that role) -- SECURITY
--     DEFINER then runs it with the owner's privileges regardless of who
--     (supabase_auth_admin) triggered the insert.
--   * set search_path = '' is not just style here -- an unqualified name
--     inside a SECURITY DEFINER function is a real privilege-escalation
--     vector (a caller could get their own same-named object picked up
--     with the function owner's privileges), so every reference below is
--     fully schema-qualified.
--   * Per Supabase's own migration-hygiene warning (also called out in
--     0001_schema.sql's header), only auth.users.id is ever depended on --
--     email is read here too (it's the whole point of this trigger), but
--     nothing about its exact validation/normalization rules is assumed
--     beyond "lowercase it before comparing", which invite_member() already
--     does on its side of every stored row.
--   * MOST IMPORTANT: if this trigger function raises/fails, the ENTIRE
--     signup transaction rolls back -- Supabase's docs explicitly warn a
--     failing trigger here blocks signup itself. This is the exact same
--     "zero-rows/no-op, not raise" lesson already baked into this project's
--     device_auth_failures handling (0003/0004_*.sql): an unmatched invite
--     (the overwhelmingly common case -- most signups have no pending
--     invite at all) must be a silent no-op, never an error. The EXCEPTION
--     WHEN OTHERS block below is deliberately broad -- unlike the
--     device_auth_failures case (where a nested BEGIN/EXCEPTION block
--     specifically does NOT protect against a later raise in the same
--     outer scope, because there the goal was to let an earlier INSERT
--     survive a raise happening AFTER it), here the goal is different and
--     simpler: swallow ANY failure in invite resolution and let the signup
--     proceed regardless, full stop. There's no later raise to protect
--     against and no audit-log insert this needs to survive -- so a broad
--     catch-and-continue is the correct shape here, not a workaround.
-- ============================================================================

create or replace function public.handle_new_user_invites()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  -- Only resolve invites once the email is actually CONFIRMED, not merely
  -- present on the row. email_confirmed_at is null at INSERT time for a
  -- typical password-based signup (it only becomes non-null via a LATER
  -- UPDATE, when the person clicks their confirmation link) -- resolving
  -- on bare INSERT would grant org membership to whoever merely typed that
  -- email into a signup form, not whoever actually proved they control it.
  -- This is the same account-squatting concern as invite_member()'s
  -- existing-user branch (0007_org_management_functions.sql), just hit
  -- from the trigger side instead. The trigger below fires on INSERT (for
  -- providers/flows where email arrives pre-confirmed, e.g. some OAuth
  -- sign-ins) AND on UPDATE OF email_confirmed_at (the ordinary
  -- password-signup confirmation path) -- this check is what makes firing
  -- on an irrelevant/already-resolved update harmless either way.
  if new.email_confirmed_at is null then
    return new;
  end if;

  v_email := lower(new.email);

  if v_email is null then
    return new;
  end if;

  insert into public.organization_members (org_id, user_id, role)
  select oi.org_id, new.id, oi.role
  from public.organization_invites oi
  where oi.email = v_email
    and oi.accepted_at is null
    and oi.revoked_at is null
  on conflict (org_id, user_id) do nothing;

  update public.organization_invites oi
  set accepted_at = now()
  where oi.email = v_email
    and oi.accepted_at is null
    and oi.revoked_at is null;

  return new;
exception
  when others then
    -- Never block signup because of invite-resolution issues -- see file
    -- header. Deliberately broad: any failure here (constraint quirk,
    -- unexpected data shape, anything) must still let the signup itself
    -- succeed.
    return new;
end;
$$;

comment on function public.handle_new_user_invites() is
  'AFTER INSERT ON auth.users: turns every still-pending organization_invites row matching the new user''s email into a real organization_members row, and marks those invites accepted. Never raises -- an unmatched email (the common case) is a silent no-op, and any unexpected failure is swallowed so signup itself is never blocked. SECURITY DEFINER, owned by postgres -- supabase_auth_admin (who actually performs the INSERT INTO auth.users) has no privileges on the public schema otherwise.';

revoke all on function public.handle_new_user_invites() from public;
-- Deliberately no EXECUTE grant to anon/authenticated/service_role: this
-- function only makes sense invoked as a trigger (it dereferences NEW,
-- which Postgres already refuses to allow outside a trigger context) --
-- nobody should ever call it directly as an RPC.

-- Fires on INSERT (covers a row that arrives already-confirmed, e.g. some
-- OAuth sign-in flows) and on UPDATE OF email_confirmed_at (covers the
-- ordinary password-signup path, where confirmation happens via a later
-- UPDATE, not the original INSERT). The function itself still re-checks
-- new.email_confirmed_at is not null and is fully idempotent (ON CONFLICT
-- DO NOTHING, and the UPDATE only matches still-pending invites), so firing
-- on an UPDATE that isn't actually a confirmation transition is harmless,
-- not just theoretically safe.
--
-- Resolves pending organization_invites into organization_members once a
-- user's email is actually CONFIRMED (not merely present) -- whether from
-- organic signup confirmation or supabase.auth.admin.inviteUserByEmail() --
-- see above for why both INSERT and UPDATE OF email_confirmed_at are
-- needed, and why resolving on unconfirmed email would be an
-- account-squatting vector.
--
-- Deliberately no `comment on trigger ... on auth.users` here (unlike the
-- `comment on function` above): a stored comment on a trigger requires
-- owning its table, and auth.users is owned by supabase_auth_admin, not
-- postgres (the role migrations run as) -- confirmed by actually running
-- this migration against a real local Supabase stack, which failed with
-- "must be owner of relation users" the one time this used `comment on
-- trigger`. CREATE TRIGGER itself only needs the (already-granted) TRIGGER
-- privilege, so the trigger works fine; only a catalog comment on it does
-- not. This plain SQL comment carries the same explanation with no such
-- requirement.
drop trigger if exists on_auth_user_created_resolve_invites on auth.users;
create trigger on_auth_user_created_resolve_invites
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.handle_new_user_invites();
