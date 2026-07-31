-- ============================================================================
-- AI 虚拟手机 · Supabase 一键初始化脚本（all-in-one）
-- 在 SQL Editor 整段执行一次即可建齐全部可选云端功能：账号/激活码/会话、
-- 成年审核+审核图片桶（见 docs/verify-setup.md）、便签墙、游戏大厅、
-- 应用市场、黑市。全部语句幂等，重复执行不报错、不破坏已有数据。
-- 执行前请确认最后一行是 "-- ===== 全部结束 ====="，缺了说明复制被截断。
-- ============================================================================
-- ==================== docs/account-supabase.sql ====================
-- Account, activation code, and session foundation.
-- Run this in Supabase SQL Editor before enabling account login.

create table if not exists public.app_users (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  display_name text not null,
  status text not null default 'active',
  activated_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_users_username_check check (username ~ '^[A-Za-z0-9_@.-]{3,40}$'),
  constraint app_users_status_check check (status in ('active', 'disabled'))
);

-- 单机模式（NEXT_PUBLIC_SELF_HOSTED_MODE）下服务端使用固定账号 local_user；
-- 黑市等云端表对 app_users 有外键，这里预置占位行，否则单机模式开钱包会
-- 报外键错误。password_hash 为无法通过校验的占位值，此账号不可登录。
insert into public.app_users (id, username, password_hash, display_name, status)
values ('local_user', 'local_user', 'self_hosted_placeholder', '本地用户', 'active')
on conflict do nothing;

create table if not exists public.activation_codes (
  code text primary key,
  label text,
  status text not null default 'active',
  max_uses integer not null default 1,
  used_count integer not null default 0,
  last_used_by text references public.app_users(id) on delete set null,
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activation_codes_status_check check (status in ('active', 'disabled')),
  constraint activation_codes_max_uses_check check (max_uses >= 1),
  constraint activation_codes_used_count_check check (used_count >= 0)
);

create table if not exists public.app_sessions (
  token_hash text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  user_agent text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists app_sessions_user_idx
  on public.app_sessions (user_id, expires_at desc);

create index if not exists app_sessions_expires_idx
  on public.app_sessions (expires_at);

alter table public.app_users enable row level security;
alter table public.activation_codes enable row level security;
alter table public.app_sessions enable row level security;

-- These tables are written through Next.js API routes with the service role key.
-- Do not grant anon insert/update permissions here.

-- Atomic registration: claim an activation code and create the account in one
-- transaction. The activation code row is locked (FOR UPDATE) so two concurrent
-- first-time registrations with the same code cannot both succeed past max_uses.
create or replace function public.app_register_account(
  p_id text,
  p_username text,
  p_password_hash text,
  p_display_name text,
  p_code text
)
returns public.app_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.activation_codes;
  v_user public.app_users;
  v_now timestamptz := now();
begin
  -- Serialize concurrent claims of the same code.
  select * into v_code
  from public.activation_codes
  where code = p_code
  for update;

  if not found then
    raise exception 'activation_code_not_found';
  end if;
  if v_code.status <> 'active' then
    raise exception 'activation_code_disabled';
  end if;
  if v_code.expires_at is not null and v_code.expires_at <= v_now then
    raise exception 'activation_code_expired';
  end if;
  if v_code.used_count >= v_code.max_uses then
    raise exception 'activation_code_exhausted';
  end if;

  if exists (select 1 from public.app_users where username = p_username) then
    raise exception 'username_taken';
  end if;

  insert into public.app_users
    (id, username, password_hash, display_name, status, activated_at, last_login_at, created_at, updated_at)
  values
    (p_id, p_username, p_password_hash, coalesce(nullif(p_display_name, ''), p_username),
     'active', v_now, v_now, v_now, v_now)
  returning * into v_user;

  update public.activation_codes
  set used_count = used_count + 1,
      last_used_by = p_id,
      last_used_at = v_now,
      updated_at = v_now
  where code = p_code;

  return v_user;
end;
$$;

-- Example activation code. Change this before public release.
-- insert into public.activation_codes (code, label, max_uses)
-- values ('CHANGE_ME', 'internal test', 20)
-- on conflict (code) do update
-- set label = excluded.label,
--     max_uses = excluded.max_uses,
--     status = 'active',
--     updated_at = now();
-- ==================== docs/verify-supabase.sql ====================
-- 成年审核 · 激活码自助申请
-- 在 Supabase SQL Editor 中执行一次。
-- 依赖：docs/account-supabase.sql（activation_codes 表）已执行。

create table if not exists public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  query_code text not null unique,
  contact text not null,
  image_path text,
  status text not null default 'pending',
  activation_code text,
  note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint verification_requests_status_check check (status in ('pending', 'approved', 'rejected'))
);

-- 开启 RLS 且不创建任何 policy：仅 service_role（服务端 API）可读写。
alter table public.verification_requests enable row level security;

create index if not exists verification_requests_status_idx
  on public.verification_requests (status, created_at desc);

-- 私有图片桶（public=false：匿名/客户端不可读，只有服务端能取）
insert into storage.buckets (id, name, public)
values ('verification-images', 'verification-images', false)
on conflict (id) do nothing;
-- ==================== docs/notewall-supabase.sql ====================
-- Supabase SQL for the global note wall.
-- Run this once in the Supabase SQL editor.

create table if not exists public.note_wall_boards (
  id text primary key,
  title text not null default '便签墙',
  width integer not null default 1600,
  height integer not null default 1200,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.note_wall_notes (
  id uuid primary key default gen_random_uuid(),
  board_id text not null references public.note_wall_boards(id) on delete cascade,

  author_type text not null check (author_type in ('user', 'character')),
  author_id text not null,
  author_name text not null,
  is_anonymous boolean not null default false,

  summary text not null,
  body text not null,

  x integer not null,
  y integer not null,
  width integer not null,
  height integer not null,
  size text not null default 'medium' check (size in ('small', 'medium', 'large')),

  paper text not null default 'plain',
  tape text not null default 'none',
  font text not null default 'default',
  decoration text not null default 'none',

  raw_css text,
  safe_style jsonb not null default '{}'::jsonb,

  created_by text,
  updated_by text,
  deleted_by text,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.note_wall_notes
  add column if not exists is_anonymous boolean not null default false;

create index if not exists note_wall_notes_board_created_idx
  on public.note_wall_notes (board_id, created_at);

create table if not exists public.note_wall_comments (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.note_wall_notes(id) on delete cascade,

  author_id text not null,
  author_name text not null,
  body text not null,
  is_anonymous boolean not null default false,

  created_by text,
  deleted_by text,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.note_wall_comments
  add column if not exists is_anonymous boolean not null default false;

create index if not exists note_wall_comments_note_created_idx
  on public.note_wall_comments (note_id, created_at);

insert into public.note_wall_boards (id, title, width, height)
values ('global', '便签墙', 1600, 1200)
on conflict (id) do nothing;

alter table public.note_wall_boards enable row level security;
alter table public.note_wall_notes enable row level security;
alter table public.note_wall_comments enable row level security;

grant select on public.note_wall_boards to anon;
grant select on public.note_wall_notes to anon;
grant select on public.note_wall_comments to anon;

drop policy if exists "note_wall_boards_public_read" on public.note_wall_boards;
create policy "note_wall_boards_public_read"
  on public.note_wall_boards
  for select
  to anon
  using (true);

drop policy if exists "note_wall_notes_public_read" on public.note_wall_notes;
create policy "note_wall_notes_public_read"
  on public.note_wall_notes
  for select
  to anon
  using (deleted_at is null);

drop policy if exists "note_wall_comments_public_read" on public.note_wall_comments;
create policy "note_wall_comments_public_read"
  on public.note_wall_comments
  for select
  to anon
  using (deleted_at is null);

alter table public.note_wall_boards replica identity full;
alter table public.note_wall_notes replica identity full;
alter table public.note_wall_comments replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'note_wall_boards'
  ) then
    alter publication supabase_realtime add table public.note_wall_boards;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'note_wall_notes'
  ) then
    alter publication supabase_realtime add table public.note_wall_notes;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'note_wall_comments'
  ) then
    alter publication supabase_realtime add table public.note_wall_comments;
  end if;
end $$;
-- ==================== docs/game-hall-supabase.sql ====================
-- Supabase SQL for the game hall marketplace.
-- Run this once in the Supabase SQL editor.

create table if not exists public.game_hall_games (
  id text primary key,

  title text not null,
  code_name text not null,
  subtitle text not null default '',
  synopsis text not null default '',
  play_note text not null default '',
  cover_image text not null default '',
  tags jsonb not null default '[]'::jsonb,

  author_id text not null default 'anonymous',
  author_name text not null default '匿名作者',
  author_avatar text not null default '',
  source text not null default 'community' check (source in ('builtin', 'community', 'local')),
  version integer not null default 1,

  role_slots jsonb not null default '[]'::jsonb,
  picker_html text not null,
  game_html text not null,
  allow_external_control boolean not null default false,

  purchase_count integer not null default 0 check (purchase_count >= 0),
  rating numeric not null default 0 check (rating >= 0 and rating <= 5),
  like_count integer not null default 0 check (like_count >= 0),
  favorite_count integer not null default 0 check (favorite_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.game_hall_games
  add column if not exists role_slots jsonb not null default '[]'::jsonb;

alter table public.game_hall_games
  add column if not exists picker_html text not null default '';

alter table public.game_hall_games
  add column if not exists game_html text not null default '';

alter table public.game_hall_games
  add column if not exists allow_external_control boolean not null default false;

alter table public.game_hall_games
  add column if not exists play_note text not null default '';

alter table public.game_hall_games
  add column if not exists cover_image text not null default '';

alter table public.game_hall_games
  add column if not exists author_avatar text not null default '';

alter table public.game_hall_games
  add column if not exists like_count integer not null default 0 check (like_count >= 0);

alter table public.game_hall_games
  add column if not exists favorite_count integer not null default 0 check (favorite_count >= 0);

alter table public.game_hall_games
  add column if not exists comment_count integer not null default 0 check (comment_count >= 0);

create index if not exists game_hall_games_updated_idx
  on public.game_hall_games (updated_at desc)
  where deleted_at is null;

create index if not exists game_hall_games_author_idx
  on public.game_hall_games (author_id, updated_at desc)
  where deleted_at is null;

create index if not exists game_hall_games_tags_idx
  on public.game_hall_games using gin (tags);

create table if not exists public.game_hall_likes (
  game_id text not null references public.game_hall_games(id) on delete cascade,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (game_id, user_id)
);

create index if not exists game_hall_likes_user_idx
  on public.game_hall_likes (user_id, created_at desc);

create table if not exists public.game_hall_favorites (
  game_id text not null references public.game_hall_games(id) on delete cascade,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (game_id, user_id)
);

create index if not exists game_hall_favorites_user_idx
  on public.game_hall_favorites (user_id, created_at desc);

create table if not exists public.game_hall_comments (
  id text primary key,
  game_id text not null references public.game_hall_games(id) on delete cascade,
  parent_id text references public.game_hall_comments(id) on delete cascade,
  author_id text not null,
  author_name text not null default '匿名玩家',
  author_avatar text not null default '',
  content text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.game_hall_comments
  add column if not exists parent_id text references public.game_hall_comments(id) on delete cascade;

create index if not exists game_hall_comments_game_idx
  on public.game_hall_comments (game_id, created_at asc)
  where deleted_at is null;

create index if not exists game_hall_comments_parent_idx
  on public.game_hall_comments (game_id, parent_id, created_at asc)
  where deleted_at is null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'game-hall-assets',
  'game-hall-assets',
  true,
  1048576,
  array['image/webp', 'image/png', 'image/jpeg']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.game_hall_games enable row level security;
alter table public.game_hall_likes enable row level security;
alter table public.game_hall_favorites enable row level security;
alter table public.game_hall_comments enable row level security;

-- 收回 anon 直读：game_hall_games 含 game_html/picker_html 整套游戏源码，
-- 开放 anon 会被拿 anon key 绕过服务端 API 匿名批量爬走（likes/favorites 还会泄露用户 ID 关系）。
-- 站内所有游戏大厅读写都走 Next API + service key，无 anon 直连依赖。
revoke select on public.game_hall_games from anon;
revoke select on public.game_hall_likes from anon;
revoke select on public.game_hall_favorites from anon;
revoke select on public.game_hall_comments from anon;

drop policy if exists "game_hall_games_public_read" on public.game_hall_games;
drop policy if exists "game_hall_likes_public_read" on public.game_hall_likes;
drop policy if exists "game_hall_favorites_public_read" on public.game_hall_favorites;
drop policy if exists "game_hall_comments_public_read" on public.game_hall_comments;

alter table public.game_hall_games replica identity full;
alter table public.game_hall_likes replica identity full;
alter table public.game_hall_favorites replica identity full;
alter table public.game_hall_comments replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_hall_games'
  ) then
    alter publication supabase_realtime add table public.game_hall_games;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'game_hall_comments'
  ) then
    alter publication supabase_realtime add table public.game_hall_comments;
  end if;
end $$;

notify pgrst, 'reload schema';
-- ==================== docs/custom-app-market-supabase.sql ====================
-- Supabase SQL for the custom app marketplace.
-- Run this once in the Supabase SQL editor.

create table if not exists public.custom_app_market_apps (
  id text primary key,
  app_id text not null,
  name text not null,
  version text not null default '1.0.0',
  changelog text not null default '',
  description text not null default '',
  icon_data_url text not null default '',
  permissions jsonb not null default '[]'::jsonb,
  manifest jsonb not null default '{}'::jsonb,

  package_url text not null,
  package_path text not null,
  package_kind text not null default 'floatapp' check (package_kind in ('floatapp', 'zip', 'html')),
  package_size integer not null default 0 check (package_size >= 0),

  author_id text not null,
  author_name text not null default '匿名作者',
  author_avatar text not null default '',

  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  install_count integer not null default 0 check (install_count >= 0),
  like_count integer not null default 0 check (like_count >= 0),

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.custom_app_market_apps
  add column if not exists app_id text not null default '';

alter table public.custom_app_market_apps
  add column if not exists changelog text not null default '';

alter table public.custom_app_market_apps
  add column if not exists icon_data_url text not null default '';

alter table public.custom_app_market_apps
  add column if not exists permissions jsonb not null default '[]'::jsonb;

alter table public.custom_app_market_apps
  add column if not exists manifest jsonb not null default '{}'::jsonb;

alter table public.custom_app_market_apps
  add column if not exists package_url text not null default '';

alter table public.custom_app_market_apps
  add column if not exists package_path text not null default '';

alter table public.custom_app_market_apps
  add column if not exists package_kind text not null default 'floatapp' check (package_kind in ('floatapp', 'zip', 'html'));

alter table public.custom_app_market_apps
  add column if not exists package_size integer not null default 0 check (package_size >= 0);

alter table public.custom_app_market_apps
  add column if not exists review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected'));

alter table public.custom_app_market_apps
  add column if not exists install_count integer not null default 0 check (install_count >= 0);

alter table public.custom_app_market_apps
  add column if not exists like_count integer not null default 0 check (like_count >= 0);

create index if not exists custom_app_market_apps_review_idx
  on public.custom_app_market_apps (review_status, updated_at desc)
  where deleted_at is null;

create index if not exists custom_app_market_apps_author_idx
  on public.custom_app_market_apps (author_id, updated_at desc)
  where deleted_at is null;

create index if not exists custom_app_market_apps_app_id_idx
  on public.custom_app_market_apps (app_id);

create unique index if not exists custom_app_market_apps_app_id_unique_idx
  on public.custom_app_market_apps (app_id)
  where deleted_at is null;

create unique index if not exists custom_app_market_apps_name_unique_idx
  on public.custom_app_market_apps (lower(name))
  where deleted_at is null;

-- 包内容 SHA-256（服务端在发布/更新时计算），用于拒绝「原样重传倒卖」他人应用包
alter table public.custom_app_market_apps
  add column if not exists package_hash text not null default '';

create index if not exists custom_app_market_apps_package_hash_idx
  on public.custom_app_market_apps (package_hash)
  where deleted_at is null and package_hash <> '';

-- 应用包下载留痕：限频依据 + 异常爬取排查（谁、何时、下了哪个包）
create table if not exists public.custom_app_package_downloads (
  id text primary key,
  app_row_id text not null,
  account_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists custom_app_package_downloads_account_idx
  on public.custom_app_package_downloads (account_id, created_at desc);

create index if not exists custom_app_package_downloads_app_idx
  on public.custom_app_package_downloads (app_row_id, created_at desc);

alter table public.custom_app_package_downloads enable row level security;

-- 应用包存储桶：私有。下载一律经服务端 /api/app-market/download 校验后
-- 换发短时签名 URL（登录 + 每小时限频 + 留痕），防匿名批量爬取创作者的包。
-- 存量对象无需搬迁：翻私有只改桶标志位，文件路径原地不动，service key 照常可读。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'custom-app-market-packages',
  'custom-app-market-packages',
  false,
  5242880,
  array['application/zip', 'application/octet-stream', 'text/html']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.custom_app_market_apps enable row level security;

-- 收回 anon 直读：package_url 直链等列不能绕过服务端 API 被批量拉走。
-- （站内所有市场读写都走 Next API + service key，本无 anon 直连依赖。）
revoke select on public.custom_app_market_apps from anon;

drop policy if exists "custom_app_market_apps_public_read" on public.custom_app_market_apps;

alter table public.custom_app_market_apps replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'custom_app_market_apps'
  ) then
    alter publication supabase_realtime add table public.custom_app_market_apps;
  end if;
end $$;

notify pgrst, 'reload schema';
-- ==================== docs/black-market-supabase.sql ====================
-- Supabase SQL for the black market theater marketplace.
-- Run this once in the Supabase SQL editor.

create table if not exists public.black_market_theaters (
  id text primary key,

  title text not null,
  code_name text not null,
  file_number text not null default '',
  subtitle text not null default '',
  synopsis text not null default '',
  story_text text not null default '',
  tags jsonb not null default '[]'::jsonb,
  rarity text not null default 'common' check (rarity in ('common', 'rare', 'legend', 'encrypted')),
  glyph text not null default '◆',
  price integer not null default 0 check (price >= 0 and price <= 500),

  author_id text not null default 'anonymous',
  author_name text not null default '匿名卖家',
  source text not null default 'community' check (source in ('builtin', 'community', 'local')),
  version integer not null default 1,
  duration_turns integer not null default 8 check (duration_turns >= 1 and duration_turns <= 30),
  allow_external_control boolean not null default false,

  opening_html text not null,
  ai_instruction text not null,
  output_contract text not null default '',
  render_rules jsonb not null default '[]'::jsonb,
  render_css text not null default '',
  memory_summary_prompt text not null default '',

  purchase_count integer not null default 0 check (purchase_count >= 0),
  rating numeric not null default 0 check (rating >= 0 and rating <= 5),

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.black_market_theaters
  add column if not exists file_number text not null default '';

alter table public.black_market_theaters
  add column if not exists allow_external_control boolean not null default false;

create index if not exists black_market_theaters_updated_idx
  on public.black_market_theaters (updated_at desc)
  where deleted_at is null;

create index if not exists black_market_theaters_author_idx
  on public.black_market_theaters (author_id, updated_at desc)
  where deleted_at is null;

create index if not exists black_market_theaters_tags_idx
  on public.black_market_theaters using gin (tags);

alter table public.black_market_theaters enable row level security;

-- 收回 anon 直读：剧场模板是用户创作内容，开放 anon 会被拿 anon key
-- 绕过服务端 API 匿名批量爬走。站内读写都走 Next API + service key，无 anon 直连依赖。
revoke select on public.black_market_theaters from anon;

drop policy if exists "black_market_theaters_public_read" on public.black_market_theaters;

alter table public.black_market_theaters replica identity full;

create table if not exists public.black_market_wallets (
  user_id text primary key references public.app_users(id) on delete cascade,
  display_name text not null default '黑市用户',
  balance integer not null default 1000 check (balance >= 0),
  last_checkin_date date,
  total_income integer not null default 0 check (total_income >= 0),
  total_spent integer not null default 0 check (total_spent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.black_market_wallet_transactions (
  id text primary key,
  user_id text not null references public.app_users(id) on delete cascade,
  type text not null check (type in ('initial_grant', 'daily_checkin', 'purchase', 'creator_income', 'manual_adjust')),
  amount integer not null,
  title text not null,
  detail text not null default '',
  theater_id text,
  theater_title text,
  counterparty_id text,
  counterparty_name text,
  balance_after integer not null,
  created_at timestamptz not null default now()
);

create index if not exists black_market_wallet_transactions_user_idx
  on public.black_market_wallet_transactions (user_id, created_at desc);

create table if not exists public.black_market_purchases (
  id text primary key,
  theater_id text not null references public.black_market_theaters(id) on delete restrict,
  buyer_id text not null references public.app_users(id) on delete cascade,
  seller_id text not null references public.app_users(id) on delete cascade,
  price integer not null check (price >= 0),
  seller_income integer not null check (seller_income >= 0),
  template_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (buyer_id, theater_id)
);

create index if not exists black_market_purchases_seller_idx
  on public.black_market_purchases (seller_id, created_at desc);

create index if not exists black_market_purchases_buyer_idx
  on public.black_market_purchases (buyer_id, created_at desc);

alter table public.black_market_wallets enable row level security;
alter table public.black_market_wallet_transactions enable row level security;
alter table public.black_market_purchases enable row level security;

create or replace function public.black_market_ensure_wallet(
  p_user_id text,
  p_display_name text default '黑市用户'
)
returns public.black_market_wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.black_market_wallets;
  v_tx_id text;
begin
  insert into public.black_market_wallets (user_id, display_name, balance)
  values (p_user_id, coalesce(nullif(p_display_name, ''), '黑市用户'), 1000)
  on conflict (user_id) do update
    set display_name = coalesce(nullif(excluded.display_name, ''), public.black_market_wallets.display_name),
        updated_at = now()
  returning * into v_wallet;

  if not exists (
    select 1 from public.black_market_wallet_transactions
    where user_id = p_user_id and type = 'initial_grant'
  ) then
    v_tx_id := 'bm_tx_' || replace(gen_random_uuid()::text, '-', '');
    insert into public.black_market_wallet_transactions (
      id, user_id, type, amount, title, detail, balance_after
    ) values (
      v_tx_id, p_user_id, 'initial_grant', 1000, '初始额度', '黑市终端初始化暗影信用点。', v_wallet.balance
    );
  end if;

  return v_wallet;
end;
$$;

create or replace function public.black_market_checkin(
  p_user_id text,
  p_display_name text default '黑市用户'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.black_market_wallets;
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_tx public.black_market_wallet_transactions;
begin
  select * into v_wallet from public.black_market_ensure_wallet(p_user_id, p_display_name);
  select * into v_wallet from public.black_market_wallets where user_id = p_user_id for update;

  if v_wallet.last_checkin_date = v_today then
    raise exception 'already_checked_in';
  end if;

  update public.black_market_wallets
  set balance = balance + 200,
      last_checkin_date = v_today,
      total_income = total_income + 200,
      updated_at = now()
  where user_id = p_user_id
  returning * into v_wallet;

  insert into public.black_market_wallet_transactions (
    id, user_id, type, amount, title, detail, balance_after
  ) values (
    'bm_tx_' || replace(gen_random_uuid()::text, '-', ''),
    p_user_id,
    'daily_checkin',
    200,
    '每日签到',
    '黑市终端发放今日暗影信用点。',
    v_wallet.balance
  ) returning * into v_tx;

  return jsonb_build_object('wallet', to_jsonb(v_wallet), 'transaction', to_jsonb(v_tx));
end;
$$;

create or replace function public.black_market_purchase_theater(
  p_buyer_id text,
  p_buyer_name text,
  p_theater_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_theater public.black_market_theaters;
  v_buyer_wallet public.black_market_wallets;
  v_seller_wallet public.black_market_wallets;
  v_purchase public.black_market_purchases;
  v_price integer;
  v_buyer_tx public.black_market_wallet_transactions;
  v_seller_tx public.black_market_wallet_transactions;
begin
  select * into v_theater
  from public.black_market_theaters
  where id = p_theater_id and deleted_at is null
  for update;

  if not found then
    raise exception 'theater_not_found';
  end if;

  if v_theater.author_id = p_buyer_id then
    raise exception 'cannot_purchase_own_theater';
  end if;

  if exists (
    select 1 from public.black_market_purchases
    where buyer_id = p_buyer_id and theater_id = p_theater_id
  ) then
    raise exception 'already_purchased';
  end if;

  v_price := greatest(0, least(500, coalesce(v_theater.price, 0)));

  select * into v_buyer_wallet from public.black_market_ensure_wallet(p_buyer_id, p_buyer_name);
  select * into v_seller_wallet from public.black_market_ensure_wallet(v_theater.author_id, v_theater.author_name);

  select * into v_buyer_wallet
  from public.black_market_wallets
  where user_id = p_buyer_id
  for update;

  select * into v_seller_wallet
  from public.black_market_wallets
  where user_id = v_theater.author_id
  for update;

  if v_buyer_wallet.balance < v_price then
    raise exception 'insufficient_shadow_credits';
  end if;

  update public.black_market_wallets
  set balance = balance - v_price,
      total_spent = total_spent + v_price,
      updated_at = now()
  where user_id = p_buyer_id
  returning * into v_buyer_wallet;

  update public.black_market_wallets
  set balance = balance + v_price,
      total_income = total_income + v_price,
      updated_at = now()
  where user_id = v_theater.author_id
  returning * into v_seller_wallet;

  insert into public.black_market_wallet_transactions (
    id, user_id, type, amount, title, detail, theater_id, theater_title,
    counterparty_id, counterparty_name, balance_after
  ) values (
    'bm_tx_' || replace(gen_random_uuid()::text, '-', ''),
    p_buyer_id,
    'purchase',
    -v_price,
    '购买夜间档案',
    '复制夜间档案指令：' || v_theater.title,
    v_theater.id,
    v_theater.title,
    v_theater.author_id,
    v_theater.author_name,
    v_buyer_wallet.balance
  ) returning * into v_buyer_tx;

  insert into public.black_market_wallet_transactions (
    id, user_id, type, amount, title, detail, theater_id, theater_title,
    counterparty_id, counterparty_name, balance_after
  ) values (
    'bm_tx_' || replace(gen_random_uuid()::text, '-', ''),
    v_theater.author_id,
    'creator_income',
    v_price,
    '夜间档案售出',
    '买方复制夜间档案：' || v_theater.title,
    v_theater.id,
    v_theater.title,
    p_buyer_id,
    coalesce(nullif(p_buyer_name, ''), '黑市用户'),
    v_seller_wallet.balance
  ) returning * into v_seller_tx;

  insert into public.black_market_purchases (
    id, theater_id, buyer_id, seller_id, price, seller_income, template_snapshot
  ) values (
    'bm_buy_' || replace(gen_random_uuid()::text, '-', ''),
    v_theater.id,
    p_buyer_id,
    v_theater.author_id,
    v_price,
    v_price,
    to_jsonb(v_theater)
  ) returning * into v_purchase;

  update public.black_market_theaters
  set purchase_count = purchase_count + 1,
      updated_at = now()
  where id = v_theater.id
  returning * into v_theater;

  return jsonb_build_object(
    'wallet', to_jsonb(v_buyer_wallet),
    'purchase', to_jsonb(v_purchase),
    'buyerTransaction', to_jsonb(v_buyer_tx),
    'sellerTransaction', to_jsonb(v_seller_tx),
    'theater', to_jsonb(v_theater)
  );
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'black_market_theaters'
  ) then
    alter publication supabase_realtime add table public.black_market_theaters;
  end if;
end $$;

notify pgrst, 'reload schema';
-- ===== 全部结束 =====
