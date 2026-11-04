-- pg_cron keeps one history row per run: 1,440 a day for the every-minute tick, forever.
-- Keep one week, so the free 500 MB database never fills up. (pg_net cleans its own
-- responses after pg_net.ttl, 6 hours by default.)
select cron.schedule(
  'reminder-bot-cleanup',
  '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);
