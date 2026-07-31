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
