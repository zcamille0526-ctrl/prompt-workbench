-- Migration 004: add is_draft column for draft prompts feature.
--
-- Drafts are visible only to their creator (filtered server-side by viewer
-- query param against created_by). Existing rows default to false (published),
-- preserving current behavior.
--
-- The partial index covers only draft rows so the published-prompt query
-- (the common path) is unaffected.

alter table prompts
  add column if not exists is_draft boolean not null default false;

create index if not exists prompts_draft_created_by_idx
  on prompts(created_by)
  where is_draft = true;
