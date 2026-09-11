-- Preventive Supabase egress optimizations for Mixology and Game Hall.
-- Safe to run repeatedly after the corresponding tables exist.

create or replace function public.mixology_item_list(p_author_id text default null, p_kind text default null)
returns table (
  id text, kind text, name text, hook text, tags jsonb,
  author_id text, author_name text, author_avatar text,
  like_count integer, save_count integer, view_count integer, comment_count integer,
  created_at timestamptz, updated_at timestamptz, has_cover boolean
)
language sql security definer set search_path=public
as $$
  select i.id,i.kind,i.name,i.hook,i.tags,i.author_id,i.author_name,i.author_avatar,
         i.like_count,i.save_count,i.view_count,i.comment_count,i.created_at,i.updated_at,
         coalesce(i.cover,'')<>'' as has_cover
  from public.mixology_items i
  where i.deleted_at is null
    and (p_author_id is null or i.author_id=p_author_id)
    and (p_kind is null or i.kind=p_kind)
  order by i.updated_at desc limit 100;
$$;
revoke all on function public.mixology_item_list(text,text) from public, anon, authenticated;
grant execute on function public.mixology_item_list(text,text) to service_role;

create or replace function public.mixology_recipe_list(p_author_id text default null)
returns table (
  id text, name text, intro text, char_name text, part_names jsonb,
  author_id text, author_name text, author_avatar text,
  like_count integer, save_count integer, view_count integer, comment_count integer,
  created_at timestamptz, updated_at timestamptz, has_cover boolean
)
language sql security definer set search_path=public
as $$
  select r.id,r.name,r.intro,r.char_name,r.part_names,r.author_id,r.author_name,r.author_avatar,
         r.like_count,r.save_count,r.view_count,r.comment_count,r.created_at,r.updated_at,
         coalesce(r.cover,'')<>'' as has_cover
  from public.mixology_recipes r
  where r.deleted_at is null and (p_author_id is null or r.author_id=p_author_id)
  order by r.updated_at desc limit 100;
$$;
revoke all on function public.mixology_recipe_list(text) from public, anon, authenticated;
grant execute on function public.mixology_recipe_list(text) to service_role;

create or replace function public.game_hall_user_state(p_user_id text)
returns table (liked_ids text[], favorite_ids text[])
language sql security definer set search_path=public
as $$
  select
    coalesce(array(select l.game_id from public.game_hall_likes l where l.user_id=p_user_id order by l.created_at desc),array[]::text[]) as liked_ids,
    coalesce(array(select f.game_id from public.game_hall_favorites f where f.user_id=p_user_id order by f.created_at desc),array[]::text[]) as favorite_ids;
$$;
revoke all on function public.game_hall_user_state(text) from public, anon, authenticated;
grant execute on function public.game_hall_user_state(text) to service_role;
