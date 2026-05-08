-- Migration 006: Phase 2 User System
-- Spec: docs/specs/2026-05-07-user-system-design.md §7.1
--
-- Run this ONCE in the Supabase SQL Editor against the NEW project
-- (https://xjwrzkttizxytknutaxh.supabase.co) before first production deploy.
--
-- This migration is IRREVERSIBLE in two ways:
--   1. TRUNCATE prompts / examples cascades (decision c from spec §0)
--   2. Schema changes to prompts / examples (created_by text -> created_by_id uuid)
-- Phase 1 data cannot be recovered after this runs.

-- =============================================================================
-- 1. profiles table (spec §3.1)
-- =============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text not null unique,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles(email);

alter table public.profiles enable row level security;

-- Authenticated users can read all profiles (used for "created by" display
-- and for joined GET responses that include creator display_name)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'authenticated_read_profiles'
  ) then
    create policy "authenticated_read_profiles" on public.profiles
      for select
      to authenticated
      using (true);
  end if;
end $$;

-- service_role has full access; all writes go through /api/profile/* proxy
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'service_role_all_profiles'
  ) then
    create policy "service_role_all_profiles" on public.profiles
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

-- Intentionally NO insert/update/delete policies for authenticated role.
-- All profile mutations must go through /api/profile/* endpoints using
-- service_role, which explicitly excludes is_admin from updatable fields.
-- This closes the "anon key + direct profile UPDATE self-promotion" attack.

-- =============================================================================
-- 2. prompts schema migration (spec §3.2 + decision c: wipe existing data)
-- =============================================================================

truncate table public.prompts cascade;

alter table public.prompts drop column if exists created_by;

alter table public.prompts
  add column if not exists created_by_id uuid not null
    references public.profiles(id) on delete cascade;

create index if not exists prompts_created_by_id_idx
  on public.prompts(created_by_id);

-- =============================================================================
-- 3. examples schema migration (spec §3.3)
-- =============================================================================

truncate table public.examples cascade;

alter table public.examples drop column if exists created_by;

alter table public.examples
  add column if not exists created_by_id uuid not null
    references public.profiles(id) on delete cascade;

create index if not exists examples_created_by_id_idx
  on public.examples(created_by_id);

-- =============================================================================
-- 4. invite_throttle (resend-invite rate limiting, spec §4.7 + round-4 atomic)
-- =============================================================================

create table if not exists public.invite_throttle (
  email text primary key,
  last_sent_at timestamptz not null default now()
);

alter table public.invite_throttle enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'invite_throttle'
      and policyname = 'service_role_all_invite_throttle'
  ) then
    create policy "service_role_all_invite_throttle" on public.invite_throttle
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

-- Atomic check-and-set RPC (round-4 hardening). A single
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING atomically
-- performs "read last_sent_at + check cooldown + write new timestamp",
-- so two concurrent resend requests for the same email cannot both
-- pass the cooldown and double-send the invite.
create or replace function public.try_consume_invite_throttle(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  insert into public.invite_throttle (email, last_sent_at)
  values (p_email, now())
  on conflict (email) do update
    set last_sent_at = now()
    where invite_throttle.last_sent_at < now() - interval '60 seconds'
  returning email into v_email;
  return v_email is not null;
end;
$$;

-- Lock this RPC down to service_role only. Authenticated / anon must not
-- be able to consume throttle quota directly.
revoke all on function public.try_consume_invite_throttle(text)
  from public, anon, authenticated;
grant execute on function public.try_consume_invite_throttle(text)
  to service_role;

-- =============================================================================
-- Done.
-- Admin email is NOT hardcoded here; ADMIN_EMAILS env var is read by
-- api/auth/setup-account.ts when INSERTing profile rows.
-- =============================================================================
