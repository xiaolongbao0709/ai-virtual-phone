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
