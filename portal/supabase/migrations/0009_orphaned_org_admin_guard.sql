-- 0009_orphaned_org_admin_guard.sql
--
-- Backstops the "an org must always have at least one org_admin" invariant
-- against a deletion path that bypasses change_member_role()/remove_member()
-- entirely: organization_members.user_id references auth.users(id) ON
-- DELETE CASCADE (0001_schema.sql), so deleting a user's Supabase Auth
-- account removes their organization_members row directly via the foreign
-- key -- not through remove_member(), which is the only place that guard
-- was previously enforced. If that deleted user happened to be an org's
-- sole org_admin, the org would be left with zero admins and, since
-- change_member_role()/remove_member() both require the CALLER to already
-- be an org_admin of the target org, permanently unmanageable through any
-- normal RPC ever again (no member could promote anyone, remove anyone, or
-- invite a replacement admin).
--
-- Fixed with an AFTER DELETE trigger on organization_members itself, rather
-- than a trigger on auth.users specifically -- this way it backstops EVERY
-- deletion path uniformly (the CASCADE from an account deletion, and, as a
-- pure defense-in-depth belt-and-suspenders, remove_member()'s own direct
-- DELETE too, even though that path already guards against this itself).

create or replace function public.handle_member_removed_promote_if_orphaned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining_admins int;
  v_promote_user_id uuid;
begin
  -- Only relevant if the row that just disappeared WAS an org_admin -- a
  -- non-admin member leaving doesn't change the org's admin count.
  if old.role <> 'org_admin' then
    return old;
  end if;

  select count(*) into v_remaining_admins
  from public.organization_members om
  where om.org_id = old.org_id
    and om.role = 'org_admin';

  if v_remaining_admins > 0 then
    return old;
  end if;

  -- The org just lost its last org_admin. Auto-promote the earliest-joined
  -- remaining member, if any, so the org stays manageable rather than
  -- silently becoming a permanent dead end.
  select om.user_id into v_promote_user_id
  from public.organization_members om
  where om.org_id = old.org_id
  order by om.created_at asc
  limit 1;

  if v_promote_user_id is not null then
    update public.organization_members
    set role = 'org_admin'
    where org_id = old.org_id and user_id = v_promote_user_id;
  end if;
  -- If v_promote_user_id is null, the org has zero members left at all --
  -- nothing to promote, and a zero-member org poses no privilege risk:
  -- there is no one left who could misuse admin status that doesn't exist.

  return old;
end;
$$;

comment on function public.handle_member_removed_promote_if_orphaned() is
  'AFTER DELETE on organization_members: if the deleted row was an org''s last org_admin, auto-promotes the earliest-joined remaining member so the org is never left permanently unmanageable. Backstops every deletion path, including the auth.users ON DELETE CASCADE (account deletion), which bypasses remove_member()''s own last-admin guard entirely since Postgres performs that delete directly via the foreign key, not through the function.';

revoke all on function public.handle_member_removed_promote_if_orphaned() from public;
-- No EXECUTE grant to anon/authenticated/service_role: like
-- handle_new_user_invites() in 0008, this only makes sense as a trigger (it
-- dereferences OLD, which Postgres refuses outside a trigger context) --
-- nobody should ever call it directly as an RPC.

drop trigger if exists on_member_removed_promote_if_orphaned on public.organization_members;
create trigger on_member_removed_promote_if_orphaned
  after delete on public.organization_members
  for each row execute function public.handle_member_removed_promote_if_orphaned();

comment on trigger on_member_removed_promote_if_orphaned on public.organization_members is
  'Auto-promotes a replacement org_admin whenever a delete (any path, including the auth.users ON DELETE CASCADE from account deletion) leaves an org with zero org_admins but at least one other member.';
