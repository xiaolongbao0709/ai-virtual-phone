-- Offline Web Push foundation: subscriptions, VAPID config, scheduled jobs, server outbox.
-- Run this in Supabase SQL Editor. Requires account-supabase.sql (app_users) first.
-- 仅供已有“站点账号共享推送”部署维护；新用户不要运行本文件。
-- 新版默认在「设置 → 云服务部署」中为每位用户创建独立项目，使用
-- docs/personal-push-supabase.sql，并且不会向站点主业务库写入个人云表。

-- 服务端推送密钥（VAPID）：首次调用 /api/push/public-key 时自动生成并写入，无需手动填。
-- cron_secret：pg_cron 扫描唤醒执行函数用的令牌，同样自动生成。
create table if not exists public.push_server_config (
  id text primary key,
  vapid_public_key text not null,
  vapid_private_key text not null,
  cron_secret text,
  created_at timestamptz not null default now()
);

alter table public.push_server_config add column if not exists cron_secret text;
-- 快照加解密专用密钥：Next 路由与 Edge Function 共用（避免两端环境变量不一致）
alter table public.push_server_config add column if not exists payload_key text;

-- 浏览器推送订阅：一台设备一行（endpoint 唯一）。
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  user_agent text,
  fail_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

-- 兜底生成预约（第2期起使用）：客户端把组装好的请求快照和触发时间预约到这里，
-- 本地正常触发就撤销；没撤销的由 cron 到点接管执行。
create table if not exists public.push_jobs (
  id text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  trigger_key text not null,
  kind text not null,
  execute_at timestamptz not null,
  status text not null default 'pending',
  payload jsonb not null,
  result_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_jobs_status_check check (status in ('pending', 'running', 'done', 'cancelled', 'failed')),
  constraint push_jobs_kind_check check (kind in ('followup', 'reply_bailout', 'timed_task'))
);

create unique index if not exists push_jobs_trigger_idx
  on public.push_jobs (user_id, trigger_key);

create index if not exists push_jobs_due_idx
  on public.push_jobs (status, execute_at);

-- 服务端生成的原始输出（第2期起使用）：客户端回来后拉走，
-- 用本地同一条解析管线落进聊天记录，然后标记已消费。
create table if not exists public.push_outbox (
  id text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  job_id text,
  session_id text,
  trigger_key text,
  raw_text text not null,
  meta jsonb,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists push_outbox_user_idx
  on public.push_outbox (user_id, consumed_at, created_at);

-- 角色主动调用用户登记的 iPhone 快捷动作。
-- 每条命令直接记录目标快捷指令，并用一次性凭证隔离文本/图片结果。
create table if not exists public.push_shortcut_commands (
  id text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  action_id text not null,
  action_name text not null,
  shortcut_name text not null,
  delivery_mode text not null default 'push',
  callback_token text not null,
  action_args jsonb not null default '{}'::jsonb,
  result_mode text not null default 'none',
  status text not null default 'pending',
  result jsonb,
  error text,
  expires_at timestamptz not null,
  notified_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_shortcut_commands_result_mode_check check (result_mode in ('none', 'text', 'image')),
  constraint push_shortcut_commands_delivery_mode_check check (delivery_mode in ('push', 'email')),
  constraint push_shortcut_commands_status_check check (status in ('pending', 'claimed', 'succeeded', 'failed', 'expired', 'cancelled'))
);

-- 旧版总执行器命令不再保留：新增直达快捷指令字段并移除 action_key。
alter table public.push_shortcut_commands add column if not exists shortcut_name text;
alter table public.push_shortcut_commands add column if not exists callback_token text;
alter table public.push_shortcut_commands add column if not exists delivery_mode text not null default 'push';
alter table public.push_shortcut_commands drop column if exists action_key;
delete from public.push_shortcut_commands
 where shortcut_name is null or callback_token is null;
alter table public.push_shortcut_commands alter column shortcut_name set not null;
alter table public.push_shortcut_commands alter column callback_token set not null;
alter table public.push_shortcut_commands drop constraint if exists push_shortcut_commands_delivery_mode_check;
alter table public.push_shortcut_commands add constraint push_shortcut_commands_delivery_mode_check
  check (delivery_mode in ('push', 'email'));

create unique index if not exists push_shortcut_commands_callback_idx
  on public.push_shortcut_commands (callback_token);

create index if not exists push_shortcut_commands_user_idx
  on public.push_shortcut_commands (user_id, created_at desc);

create index if not exists push_shortcut_commands_pending_idx
  on public.push_shortcut_commands (user_id, status, expires_at);

-- 实验性邮件自动执行：收件地址必须先通过验证码确认。
-- Next 环境还需配置 RESEND_API_KEY、REALITY_BRIDGE_EMAIL_FROM，
-- 建议另设 SHORTCUT_EMAIL_VERIFICATION_SECRET。
create table if not exists public.push_shortcut_email_config (
  user_id text primary key references public.app_users(id) on delete cascade,
  recipient text not null,
  verified_at timestamptz,
  verification_hash text,
  verification_expires_at timestamptz,
  verification_sent_at timestamptz,
  verification_attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_shortcut_email_config
  add column if not exists verification_attempts integer not null default 0;

-- 云端代发邮件的频控窗口（个人云离线生成触发邮件模式快捷动作时用固定窗口计数）
alter table public.push_shortcut_email_config
  add column if not exists cloud_delivery_count integer not null default 0;
alter table public.push_shortcut_email_config
  add column if not exists cloud_delivery_window_start timestamptz;

-- 云端代发邮件的频控：行锁下读改写，两个并发请求不会都读到同一个旧计数而双双放行。
-- 返回 true 表示本次获得配额。RPC 不存在时 API 路由会退回非原子的读改写实现，
-- 老库不执行本段也不会坏，只是并发下同一窗口可能多放行一两封。
--
-- 窗口与上限写死在函数里，不接受调用方指定：这是 security definer 函数，会绕过
-- RLS，参数越少攻击面越小。下面还会把 PUBLIC 的执行权限收掉，只留 service_role。
-- 早期版本是三参数签名，先删掉，避免两个重载并存。
drop function if exists public.push_shortcut_email_claim_slot(text, integer, integer);

create or replace function public.push_shortcut_email_claim_slot(p_user_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_seconds constant integer := 60;
  v_max constant integer := 6;
  v_row public.push_shortcut_email_config;
  v_within boolean;
  v_count integer;
begin
  select * into v_row from public.push_shortcut_email_config
    where user_id = p_user_id for update;
  if not found then
    return false;
  end if;

  v_within := v_row.cloud_delivery_window_start is not null
    and now() - v_row.cloud_delivery_window_start < make_interval(secs => v_window_seconds);
  v_count := case when v_within then coalesce(v_row.cloud_delivery_count, 0) else 0 end;

  if v_within and v_count >= v_max then
    return false;
  end if;

  update public.push_shortcut_email_config
    set cloud_delivery_count = v_count + 1,
        cloud_delivery_window_start = case when v_within then cloud_delivery_window_start else now() end,
        updated_at = now()
    where user_id = p_user_id;
  return true;
end;
$$;

-- security definer 函数默认对 PUBLIC 可执行，而 PostgREST 会把 public schema 下的
-- 函数暴露成 /rpc/ 端点。不收权限的话，未认证调用方就能以函数所有者身份改别人的
-- 频控行（顶满计数即可让那个账号的云端邮件一直被 429），自部署模式下 user_id 固定
-- 是 local_user，连猜都不用猜。这里只留 service_role。
revoke all on function public.push_shortcut_email_claim_slot(text) from public;
do $$
begin
  execute 'revoke all on function public.push_shortcut_email_claim_slot(text) from anon, authenticated';
exception when undefined_object then
  null; -- 非 Supabase 环境没有这两个角色，忽略
end $$;
do $$
begin
  execute 'grant execute on function public.push_shortcut_email_claim_slot(text) to service_role';
exception when undefined_object then
  null;
end $$;

-- 快捷指令截图临时存储：私有桶，只能经 push-shortcut-result Edge Function
-- 使用每条命令的 callback_token 上传/读取。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'shortcut-command-media',
  'shortcut-command-media',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── 现实桥服务端联动（第5期） ──
-- 规则/云配置快照：App 被杀时服务端凭这份快照替客户端处理桥事件。
-- cloud_config 与 snapshots 内含密钥，均由 API 路由加密后落库。
create table if not exists public.push_bridge_config (
  user_id text primary key references public.app_users(id) on delete cascade,
  bridge_token text not null unique,
  rules jsonb not null default '[]'::jsonb,
  cloud_config jsonb,
  rule_runs jsonb not null default '{}'::jsonb,
  daily_cap integer not null default 20,
  daily_count jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 个人云的 Supabase 源站（明文，非密钥）。云端离线生成触发邮件模式的快捷动作时，
-- 站点只负责代发那封信；信里的结果回传地址必须落在这个源站上，否则拒发——
-- 防止 bridge_token 泄露后被人把快捷指令的输出引到别处。
alter table public.push_bridge_config
  add column if not exists cloud_origin text;

-- 允许云端代发的邮件动作白名单（只存 actionId，不含动作名与参数）。站点看不到
-- 个人云那张命令表，没有这份名单就只能相信调用方报上来的 actionId——拿到
-- bridge_token 的人可以指定任意动作触发邮件。快捷指令是用户自己登记的，不能假定
-- 它永远只是截图、读数据这类低危操作。
alter table public.push_bridge_config
  add column if not exists email_action_ids text[] not null default '{}'::text[];

-- 每条「让TA回话」规则的 prompt 快照（带占位符，客户端防抖刷新）
create table if not exists public.push_bridge_snapshots (
  user_id text not null references public.app_users(id) on delete cascade,
  rule_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, rule_id)
);

-- push_jobs 增加现实桥扫描与快捷指令续写类型（旧库升级用）
alter table public.push_jobs drop constraint if exists push_jobs_kind_check;
alter table public.push_jobs add constraint push_jobs_kind_check
  check (kind in ('followup', 'reply_bailout', 'timed_task', 'bridge_scan', 'shortcut_resume'));

alter table public.push_server_config enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_jobs enable row level security;
alter table public.push_outbox enable row level security;
alter table public.push_shortcut_commands enable row level security;
alter table public.push_shortcut_email_config enable row level security;
alter table public.push_bridge_config enable row level security;
alter table public.push_bridge_snapshots enable row level security;

-- These tables are accessed only through Next.js API routes with the service
-- role key. Do not grant anon permissions.

-- ══════════════════════════════════════════════════════════════════
-- 定时扫描（pg_cron）+ 执行器（Supabase Edge Functions）
-- 每 10 秒：重置卡死任务 + 扫到期预约，有活才 HTTP 唤醒 Edge Function。
-- （pg_cron 1.5+ 支持秒级调度，Supabase 默认可用；重跑本段即覆盖旧的每分钟版）
--
-- 执行器部署（一次性，在 Supabase Dashboard 完成）：
--   1. Edge Functions → Deploy new function → 名称 push-generate，
--      粘贴仓库 supabase/functions/push-generate/index.ts 全文 → Deploy；
--   2. 同样方式部署 push-bridge（supabase/functions/push-bridge/index.ts）；
--   3. 同样方式部署 push-shortcut-result
--      （supabase/functions/push-shortcut-result/index.ts）；
--   4. 三个函数的设置里关闭「Enforce JWT verification」。push-generate 与
--      push-bridge 用 cron_secret 校验，push-shortcut-result 用每条命令的
--      callback_token 校验，不使用平台层 JWT。
--
-- 然后：
--   1. 确认 cron_secret 已生成（站点上开关一次离线推送即可）；
--   2. 把下面 URL 里的 YOUR-PROJECT-REF 换成本项目的 ref（浏览器地址栏
--      或 Project Settings 里 https://xxxx.supabase.co 的 xxxx 部分）；
--   3. 整段执行（cron.schedule 同名覆盖，重复执行安全）。
-- ══════════════════════════════════════════════════════════════════

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
