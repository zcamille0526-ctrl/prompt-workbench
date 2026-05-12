-- Migration 007: category management
--
-- Introduces a categories table to replace the hardcoded CATEGORIES array.
-- See docs/specs/2026-05-12-category-management-design.md for rationale.

create table if not exists public.categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  display_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists categories_display_order_idx on public.categories (display_order);

do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.categories'::regclass
      and tgname = 'categories_updated_at'
  ) then
    create trigger categories_updated_at
      before update on public.categories
      for each row execute function update_updated_at();
  end if;
end $$;

-- Pre-seed the five canonical categories at display_order 10-50.
insert into public.categories (name, display_order) values
  ('元提示词', 10),
  ('生图', 20),
  ('生文', 30),
  ('分析', 40),
  ('开发', 50)
on conflict (name) do nothing;

-- Backfill any non-canonical categories already present in prompts.
-- Canonical names hit on conflict (name) do nothing. Legacy names land at
-- display_order 60+ in alphabetical order.
insert into public.categories (name, display_order)
  select distinct category,
         60 + (row_number() over (order by category) - 1) * 10
  from public.prompts
  where category <> ''
on conflict (name) do nothing;

-- Soft FK: trigger enforces prompts.category must exist in categories.name.
-- FOR KEY SHARE holds a row-lock on the referenced category row; this is
-- mutually exclusive with the FOR UPDATE locks in rename_category and
-- delete_category (see migration 008), so concurrent prompt writes can't
-- slip through while an admin mutation is in flight.
create or replace function public.enforce_category_exists()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  found_id uuid;
begin
  select id into found_id from public.categories
    where name = new.category
    for key share;
  if found_id is null then
    raise exception 'category "%" does not exist', new.category
      using errcode = '23503';
  end if;
  return new;
end;
$$;

do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.prompts'::regclass
      and tgname = 'prompts_enforce_category'
  ) then
    create trigger prompts_enforce_category
      before insert or update of category on public.prompts
      for each row execute function public.enforce_category_exists();
  end if;
end $$;

-- RLS: public read (sidebar needs it pre-auth); no authenticated writes
-- (everything goes through service_role + admin check in /api/categories).
-- No explicit service_role_all policy — service_role bypasses RLS by default.
alter table public.categories enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'categories'
      and policyname = 'categories_public_read'
  ) then
    create policy "categories_public_read" on public.categories
      for select
      using (true);
  end if;
end $$;
