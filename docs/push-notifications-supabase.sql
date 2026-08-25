-- Push Notifications Table for Web Push subscriptions.
-- Run this in Supabase SQL Editor if you are using Supabase Cloud features
-- and want persistent push notifications.

create table if not exists public.push_subscriptions (
  id bigint primary key generated always as identity,
  endpoint text not null unique,
  keys_p256dh text not null,
  keys_auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS (Row Level Security)
alter table public.push_subscriptions enable row level security;

-- These tables are written through Next.js API routes with the service role key.
-- No public user access policies are required because Next.js uses the service role key.
