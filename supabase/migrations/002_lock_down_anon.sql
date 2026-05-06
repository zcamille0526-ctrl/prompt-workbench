-- Migration 002: lock down anon access
--
-- Background: 001_create_prompts.sql created an "anon_select" RLS policy
-- and the prompts table was implicitly added to the supabase_realtime
-- publication. The Supabase anon key is shipped in the frontend bundle
-- and therefore effectively public; combined with the policy and the
-- realtime subscription, every browser can read all prompts.
--
-- This migration removes both leak paths. After applying, the only way to
-- access prompts is via the backend service-role connection (api/prompts.ts).
-- The anon key must also be rotated in the Supabase Dashboard so cached
-- frontend bundles can no longer be used to read the database.

-- Drop the public SELECT policy. Idempotent: "if exists" will silently
-- no-op if the policy was already removed.
drop policy if exists "anon_select" on prompts;

-- Remove prompts from the realtime publication so even if some future
-- migration accidentally re-grants RLS, websocket subscribers cannot
-- pull row data. Wrapped in a guard so the migration is idempotent
-- (alter publication ... drop table errors if the table is not in the
-- publication).
do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'prompts'
  ) then
    alter publication supabase_realtime drop table prompts;
  end if;
end $$;

-- The examples table does not exist yet (added in a later migration as
-- part of the save-example feature). When that migration runs, it must
-- explicitly NOT create an anon_select_examples policy and must NOT add
-- examples to supabase_realtime.
