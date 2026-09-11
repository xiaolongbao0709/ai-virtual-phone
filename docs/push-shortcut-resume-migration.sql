-- Reality Bridge shortcut continuation after the PWA is suspended or killed.
-- Safe to run after docs/push-supabase.sql; no URL replacement is required.

begin;

alter table public.push_jobs drop constraint if exists push_jobs_kind_check;
alter table public.push_jobs add constraint push_jobs_kind_check
  check (kind in ('followup', 'reply_bailout', 'timed_task', 'bridge_scan', 'shortcut_resume'));

commit;

-- After running this migration, redeploy the push-generate Edge Function from:
-- supabase/functions/push-generate/index.ts
-- Also deploy push-shortcut-result and disable JWT verification:
-- supabase/functions/push-shortcut-result/index.ts
