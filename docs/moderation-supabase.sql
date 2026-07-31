-- ═══════════════════════════════════════════════════════════════════
-- 内容管理机制（举报 / 管理员 / 下架 / 封号）· Supabase 一次性初始化
-- 在 Supabase SQL 编辑器整段执行一次即可，重复执行安全（幂等）。
--
-- 执行完后，把你自己的账号提升为管理员（把 your_username 换成用户名）：
--   update public.app_users set role = 'admin' where username = 'your_username';
-- 管理员登录后，在 设置 → 管理中心 处理举报、审核与封号。
-- 没有账号体系时也可用站长密钥（环境变量 APP_MARKET_ADMIN_KEY）兜底。
-- ═══════════════════════════════════════════════════════════════════

-- ── 账号角色：user（默认）/ admin ──
alter table public.app_users
  add column if not exists role text not null default 'user';

-- ── 举报表：应用市场 / 游戏 / 游戏评论 / 联机云文档 / 联机房间 共用 ──
create table if not exists public.content_reports (
  id text primary key,
  content_type text not null check (content_type in ('market_app', 'game', 'game_comment', 'online_doc', 'online_room')),
  content_id text not null,
  content_preview text not null default '',   -- 提交时抓取的内容摘要，供管理员快速判断
  content_owner_id text not null default '',  -- 内容作者（封禁作者用）
  content_owner_name text not null default '',
  reporter_id text not null,
  reporter_name text not null default '',
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  resolution text not null default '',        -- 处理结果说明（下架/封禁/驳回…）
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists content_reports_status_idx
  on public.content_reports (status, created_at desc);
create index if not exists content_reports_reporter_idx
  on public.content_reports (reporter_id, status);
-- 同一人对同一内容只保留一条待处理举报（防刷）
create unique index if not exists content_reports_dedupe_idx
  on public.content_reports (reporter_id, content_type, content_id)
  where status = 'pending';

alter table public.content_reports enable row level security;

-- ═════ 全部结束 ═════
