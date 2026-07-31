-- ═══════════════════════════════════════════════════════════════════
-- 联机对战/共享数据（自定义 APP + 游戏大厅）· Supabase 一次性初始化
-- 在 Supabase SQL 编辑器整段执行一次即可，重复执行安全（幂等）。
--
-- 另需两步（联机功能的前提）：
--   1. 站点环境变量新增 SUPABASE_ANON_KEY（Project Settings → API →
--      anon public key）。anon key 本来就是设计为可公开的，浏览器用它
--      直连 Supabase Realtime 传输房间消息；数据表仍只走 service key。
--   2. Supabase Dashboard → Realtime 确认已启用（默认开启）。
-- ═══════════════════════════════════════════════════════════════════

-- ── 实时房间（元数据；消息走 Realtime broadcast，不落库） ──
create table if not exists public.online_rooms (
  id text primary key,
  code text not null,                    -- 4 位房号（玩家输入用）
  channel text not null,                 -- 不可猜测的 Realtime 频道名
  namespace text not null,               -- custom_app:<appId> / game:<gameId>
  host_user_id text not null,
  host_name text not null default '',
  title text not null default '',
  max_players integer not null default 8 check (max_players between 2 and 32),
  meta jsonb not null default '{}'::jsonb,
  banned_user_ids jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

-- 房号只需在"同命名空间的开放房间"里唯一，关房后可复用
create unique index if not exists online_rooms_open_code_idx
  on public.online_rooms (namespace, code) where status = 'open';
create index if not exists online_rooms_host_idx
  on public.online_rooms (host_user_id, status);
create index if not exists online_rooms_stale_idx
  on public.online_rooms (created_at) where status = 'open';

-- ── 异步共享文档（漂流瓶/排行榜/串门等） ──
create table if not exists public.online_cloud_docs (
  id text primary key,
  namespace text not null,               -- custom_app:<appId> / game:<gameId>
  collection text not null,              -- APP 自定义集合名
  owner_id text not null,
  owner_name text not null default '',
  data jsonb not null default '{}'::jsonb,
  sort_key numeric,                      -- 排行榜等排序用（可空）
  taken_by text,                         -- 漂流瓶：被谁捞走（独占取件）
  taken_at timestamptz,
  report_count integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists online_cloud_docs_ns_idx
  on public.online_cloud_docs (namespace, collection, created_at desc)
  where deleted_at is null;
create index if not exists online_cloud_docs_owner_idx
  on public.online_cloud_docs (namespace, owner_id)
  where deleted_at is null;
create index if not exists online_cloud_docs_sort_idx
  on public.online_cloud_docs (namespace, collection, sort_key desc)
  where deleted_at is null;

-- ── 权限：两张表只允许 service key 访问（RLS 开启且不加公开策略）──
alter table public.online_rooms enable row level security;
alter table public.online_cloud_docs enable row level security;

-- ═════ 全部结束 ═════
