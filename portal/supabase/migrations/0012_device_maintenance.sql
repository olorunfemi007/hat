-- Supabase platform migration. Plain Postgres test harnesses without pg_cron
-- test the functions separately; the real-stack integration checks this schedule.
create extension if not exists pg_cron;

-- Named jobs are replaced on reapplication rather than duplicated.
-- Run in the database: no service-role key on a Pi or external scheduler.
select cron.schedule(
  'hardhat-device-offline',
  '* * * * *',
  $$select count(*) from public.mark_stale_devices_offline(interval '10 minutes');$$
);

select cron.schedule(
  'hardhat-device-auth-cleanup',
  '17 * * * *',
  $$select public.cleanup_old_auth_failures(interval '24 hours');$$
);
