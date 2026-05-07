-- Migration 005: examples table — saved test-run conversations attached to a prompt.
--
-- Each row is a (prompt_id, variable_values, model, messages[]) snapshot of a
-- successful test run that the team should be able to learn from. The 5-per-
-- prompt cap is enforced in the API layer (TOCTOU race on writes is acceptable
-- per spec — at worst we'd see 6 in flight).
--
-- RLS: service_role only. All reads and writes go through our server-side
-- proxy (api/examples.ts), consistent with the security-refactor decision
-- to remove direct anon access from the database.
--
-- Realtime: prompts is no longer published to supabase_realtime (migration
-- 002). examples follows the same model — no realtime, polling only — and
-- is therefore simply not added to the publication.

create table if not exists examples (
  id uuid primary key default uuid_generate_v4(),
  prompt_id uuid not null references prompts(id) on delete cascade,
  title text,
  variable_values jsonb not null default '{}'::jsonb,
  model text not null,
  messages jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists examples_prompt_id_idx on examples(prompt_id);

alter table examples enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'examples'
      and policyname = 'service_role_all_examples'
  ) then
    create policy "service_role_all_examples" on examples
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;
