-- Migration 008: category mutation RPCs
--
-- All four use security invoker (service_role bypasses RLS by default; no
-- need for definer). Row-level FOR UPDATE locks in rename/delete interlock
-- with the FOR KEY SHARE in the prompts trigger to prevent orphan refs.

create or replace function create_category(p_name text)
returns categories
language plpgsql
security invoker
as $$
declare
  next_order integer;
  new_row categories;
begin
  -- Serialize concurrent admins so they can't read the same max(display_order)
  -- and both insert the same next_order. Auto-released at transaction end.
  perform pg_advisory_xact_lock(hashtext('categories.display_order'));

  select coalesce(max(display_order), 0) + 10 into next_order from categories;
  insert into categories (name, display_order)
    values (p_name, next_order)
    returning * into new_row;
  return new_row;
end;
$$;

create or replace function rename_category(category_id uuid, new_name text)
returns categories
language plpgsql
security invoker
as $$
declare
  old_name text;
  updated_row categories;
begin
  -- FOR UPDATE on categories row. Mutually exclusive with the trigger's
  -- FOR KEY SHARE: concurrent prompt writes wait until rename commits, or
  -- this rename waits until any in-flight prompt write commits.
  select name into old_name from categories where id = category_id for update;
  if old_name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if old_name = new_name then
    select * into updated_row from categories where id = category_id;
    return updated_row;
  end if;

  -- Order matters: UPDATE categories first. The trigger only fires on
  -- prompts INSERT/UPDATE of category, not on categories itself. The second
  -- UPDATE of prompts then sees the new name already present, trigger OK.
  -- Both statements run in the function's single transaction, so no other
  -- session observes the intermediate state.
  update categories set name = new_name where id = category_id
    returning * into updated_row;
  update prompts set category = new_name where category = old_name;
  return updated_row;
end;
$$;

create or replace function move_category(category_id uuid, direction text)
returns void
language plpgsql
security invoker
as $$
declare
  cur record;
  neighbor record;
begin
  select * into cur from categories where id = category_id for update;
  if cur is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if direction = 'up' then
    select * into neighbor from categories
      where display_order < cur.display_order
      order by display_order desc limit 1
      for update;
  elsif direction = 'down' then
    select * into neighbor from categories
      where display_order > cur.display_order
      order by display_order asc limit 1
      for update;
  else
    raise exception 'invalid_direction' using errcode = '22023';
  end if;

  if neighbor is null then
    raise exception 'cannot_move' using errcode = 'P0001';
  end if;

  -- Two-phase swap with a sentinel so that, if a unique index on
  -- display_order is ever added, the swap stays safe.
  update categories set display_order = -1 where id = cur.id;
  update categories set display_order = cur.display_order where id = neighbor.id;
  update categories set display_order = neighbor.display_order where id = cur.id;
end;
$$;

create or replace function delete_category(category_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  cat_name text;
  used_count integer;
begin
  select name into cat_name from categories where id = category_id for update;
  if cat_name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select count(*) into used_count from prompts where category = cat_name;
  if used_count > 0 then
    raise exception 'in_use:%', used_count using errcode = 'P0001';
  end if;
  delete from categories where id = category_id;
end;
$$;
