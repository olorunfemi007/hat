-- 0006_auth_throttle.sql
--
-- Cleanup for public.device_auth_failures (defined in 0001_schema.sql,
-- written to by the throttle logic in device_heartbeat,
-- lookup_device_by_claim_code, and claim_device in 0003/0004). That table
-- logs a row on every failed credential check, including against
-- nonexistent serial numbers - a sustained enumeration campaign will grow
-- it without bound unless something prunes old rows. This mirrors
-- mark_stale_devices_offline's pattern: a callable function, not baked into
-- a specific scheduler, so it can be driven by whatever this project ends
-- up using for cron (pg_cron, a Vercel cron hitting an API route with the
-- service_role key, etc.) without a further migration.

create or replace function public.cleanup_old_auth_failures(
  p_older_than interval default '1 day'
)
returns bigint
language sql
security definer
set search_path = ''
as $$
  with deleted as (
    delete from public.device_auth_failures
    where failed_at < now() - p_older_than
    returning 1
  )
  select count(*) from deleted;
$$;

comment on function public.cleanup_old_auth_failures(interval) is
  'Deletes device_auth_failures rows older than p_older_than, bounding table growth from enumeration/guessing traffic. Intended to run on the same schedule as mark_stale_devices_offline, service_role only.';

revoke all on function public.cleanup_old_auth_failures(interval) from public;
grant execute on function public.cleanup_old_auth_failures(interval) to service_role;
