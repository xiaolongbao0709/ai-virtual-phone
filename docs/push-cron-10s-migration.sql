-- 离线推送扫描频率迁移：push-jobs-scan 改为每 10 秒、单轮最多 10 单。
-- 幂等：cron.schedule 同名覆盖，可安全重跑。
-- 用法：先把下方两处 YOUR-PROJECT-REF 换成你自己的 Supabase Project Ref，
-- 再粘贴到该项目 SQL Editor 执行。新部署无需运行，本迁移只给旧版个人云升级。

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('push-jobs-scan', '10 seconds', $CRON$
  update public.push_jobs set status = 'pending', updated_at = now()
   where status = 'running' and updated_at < now() - interval '20 minutes';

  select net.http_post(
    url     := case when j.kind = 'bridge_scan'
                 then 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/push-bridge'
                 else 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/push-generate'
               end,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'jobId', j.id,
      'token', (select cron_secret from public.push_server_config where id = 'main')
    ),
    timeout_milliseconds := 5000
  )
  from (
    select id, kind from public.push_jobs
     where status = 'pending' and execute_at <= now()
     order by execute_at asc
     limit 10
  ) j;
$CRON$);
