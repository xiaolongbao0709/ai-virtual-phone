-- Supabase SQL for 独家特调（mixology）酒单 / 大厅 / 社交。
-- Run this once in the SQL editor of the DEDICATED mixology Supabase project
-- (MIXOLOGY_SUPABASE_URL / MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY)，不是账号 / session 用的主库。
--
-- mixology_items    酒单：共享材料（十一类，payload 为完整材料 JSON）
-- mixology_recipes  大厅：共享特调配方（materials 存槽位引用数组，不内嵌材料本体）
--                   引用形如 {id,kind,name,builtin?,when?}：同一 kind 可出现多条（一格叠多件，
--                   顺序即数组顺序），when 是这一件的生效条件。materials 是 jsonb，
--                   加这些字段不需要改表结构。
-- mixology_likes / mixology_saves / mixology_comments
--                   点赞 / 入柜(收藏) / 评论（楼中楼），target_type 区分材料与配方

create table if not exists public.mixology_items (
  id text primary key,

  kind text not null check (kind in ('character', 'persona', 'preface', 'base', 'flavor', 'glass', 'strength', 'ticket', 'garnish', 'encore', 'filter', 'mechanism')),
  name text not null,
  hook text not null default '',
  cover text not null default '',
  tags jsonb not null default '[]'::jsonb,
  payload jsonb not null,

  author_id text not null default 'anonymous',
  author_name text not null default '匿名调酒师',
  author_avatar text not null default '',

  like_count integer not null default 0 check (like_count >= 0),
  save_count integer not null default 0 check (save_count >= 0),
  view_count integer not null default 0 check (view_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mixology_items_kind_idx
  on public.mixology_items (kind, updated_at desc)
  where deleted_at is null;

create index if not exists mixology_items_author_idx
  on public.mixology_items (author_id, updated_at desc)
  where deleted_at is null;

create index if not exists mixology_items_tags_idx
  on public.mixology_items using gin (tags);

create table if not exists public.mixology_recipes (
  id text primary key,

  name text not null,
  intro text not null default '',
  cover text not null default '',
  char_name text not null default '',
  part_names jsonb not null default '[]'::jsonb,
  materials jsonb not null,

  author_id text not null default 'anonymous',
  author_name text not null default '匿名调酒师',
  author_avatar text not null default '',

  like_count integer not null default 0 check (like_count >= 0),
  save_count integer not null default 0 check (save_count >= 0),
  view_count integer not null default 0 check (view_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mixology_recipes_updated_idx
  on public.mixology_recipes (updated_at desc)
  where deleted_at is null;

create index if not exists mixology_recipes_author_idx
  on public.mixology_recipes (author_id, updated_at desc)
  where deleted_at is null;

create table if not exists public.mixology_likes (
  target_type text not null check (target_type in ('material', 'recipe')),
  target_id text not null,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (target_type, target_id, user_id)
);

create index if not exists mixology_likes_user_idx
  on public.mixology_likes (user_id, created_at desc);

create table if not exists public.mixology_saves (
  target_type text not null check (target_type in ('material', 'recipe')),
  target_id text not null,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (target_type, target_id, user_id)
);

create index if not exists mixology_saves_user_idx
  on public.mixology_saves (user_id, created_at desc);

create table if not exists public.mixology_comments (
  id text primary key,
  target_type text not null check (target_type in ('material', 'recipe')),
  target_id text not null,
  parent_id text references public.mixology_comments(id) on delete cascade,
  author_id text not null,
  author_name text not null default '匿名酒客',
  content text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mixology_comments_target_idx
  on public.mixology_comments (target_type, target_id, created_at asc)
  where deleted_at is null;

create index if not exists mixology_comments_parent_idx
  on public.mixology_comments (target_id, parent_id, created_at asc)
  where deleted_at is null;

alter table public.mixology_items enable row level security;
alter table public.mixology_recipes enable row level security;
alter table public.mixology_likes enable row level security;
alter table public.mixology_saves enable row level security;
alter table public.mixology_comments enable row level security;

-- 收回 anon 直读：payload/materials 是创作者的完整卡与配方源数据，
-- 开放 anon 会被拿 anon key 绕过站内 API 匿名批量爬走。
-- 站内所有酒单/大厅读写都走 Next API + service key，无 anon 直连依赖。
revoke select on public.mixology_items from anon;
revoke select on public.mixology_recipes from anon;
revoke select on public.mixology_likes from anon;
revoke select on public.mixology_saves from anon;
revoke select on public.mixology_comments from anon;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────
-- 已建库升级（老库执行这一段即可，重复执行安全；一次全跑完就是最新状态）：
--  1) kind 检查约束补齐十二类：persona（面具）、preface（序言）、filter（滤网）、mechanism（机括）
--  2) 创作者头像：两张表加 author_avatar 列
--
-- 说明：配方的 materials 列本来就是 jsonb，「一格叠多件 + 每件的生效条件」
-- 只是往那个 JSON 里多存字段，不需要改表结构，所以这里没有对应的 alter。
alter table public.mixology_items drop constraint if exists mixology_items_kind_check;
alter table public.mixology_items
  add constraint mixology_items_kind_check
  check (kind in ('character', 'persona', 'preface', 'base', 'flavor', 'glass', 'strength', 'ticket', 'garnish', 'encore', 'filter', 'mechanism'));
alter table public.mixology_items add column if not exists author_avatar text not null default '';
alter table public.mixology_recipes add column if not exists author_avatar text not null default '';
notify pgrst, 'reload schema';
