create extension if not exists "uuid-ossp";

create table prompts (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  content text not null,
  category text not null,
  tags text[] not null default '{}',
  variables jsonb not null default '[]',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-update updated_at on row change
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger prompts_updated_at
  before update on prompts
  for each row
  execute function update_updated_at();

-- RLS: deny anon access, only service_role can read/write
alter table prompts enable row level security;

create policy "service_role_all" on prompts
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Allow anon to SELECT for Realtime subscriptions
create policy "anon_select" on prompts
  for select
  using (true);
