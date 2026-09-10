-- Match Supabase auth.users.email (varchar) to the public text result.
-- Replaces the function for databases that already applied migration 0010.
create or replace function public.list_org_members(
  p_org_id uuid
)
returns table (
  user_id    uuid,
  email      text,
  role       text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_org_id is null then
    raise exception 'org_id is required' using errcode = '22004';
  end if;

  -- Direct, org_id-parameterized membership check -- never
  -- current_org_id()/current_org_role(), which only reflect the caller's
  -- currently ACTIVE org and would give a wrong answer for "list members of
  -- a specific org I manage but am not currently browsing" (same rule as
  -- every function in 0007 -- see that file's header).
  perform 1 from public.organization_members om
    where om.org_id = p_org_id and om.user_id = v_caller;
  if not found then
    raise exception 'you are not a member of this organization' using errcode = '42501';
  end if;

  return query
    select om.user_id, u.email::text, om.role, om.created_at
    from public.organization_members om
    join auth.users u on u.id = om.user_id
    where om.org_id = p_org_id
    order by om.created_at asc;
end;
$$;

comment on function public.list_org_members(uuid) is
  'Lists an org''s members with their email attached (organization_members itself never exposes email). Caller must already be a member of p_org_id. SECURITY DEFINER: authenticated has zero grants on auth.users, so this is the only sanctioned way to resolve a member''s email.';

revoke all on function public.list_org_members(uuid) from public;
grant execute on function public.list_org_members(uuid) to authenticated, service_role;
