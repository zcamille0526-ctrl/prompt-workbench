-- Migration 003: add use_count column and atomic increment RPC
--
-- Adds a per-prompt counter that increments each time someone copies the
-- prompt text. Display only; no aggregation across users.
--
-- Why an RPC instead of select+update from the API: two concurrent copies
-- with select+update can race (both read N, both write N+1, lose one).
-- The RPC executes a single SQL UPDATE with an atomic increment expression,
-- so any number of parallel calls all add up correctly.

alter table prompts add column if not exists use_count integer not null default 0;

create or replace function increment_use_count(p_id uuid)
returns void
language sql
as $$
  update prompts set use_count = use_count + 1 where id = p_id;
$$;
