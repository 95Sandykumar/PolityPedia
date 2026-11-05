-- 0002_profiles.sql  (issue 02-db-harness)
-- One row per signed-in user. RLS: a user reads and edits only their own row.
-- `role` is admin-only: the trigger at the bottom blocks a non-admin from changing it.
-- There is no insert policy on purpose. Profile rows are created by the platform
-- (a trigger on auth.users) or by an admin, never by the user's own API call.

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  role         text        not null default 'student' check (role in ('student', 'teacher', 'admin')),
  display_name text,
  lang         text        not null default 'en'      check (lang in ('en', 'hi', 'both')),
  created_at   timestamptz not null default now()
);

comment on table public.profiles is 'App profile for an auth user. RLS: own row only; role is admin-only.';

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (auth.uid() = id);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Role escalation guard.
-- SECURITY DEFINER so the admin lookup can see every profile row; without it the
-- caller's own RLS policy would hide the admin row and nobody could ever pass.
create or replace function public.profiles_block_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.role is distinct from old.role then
    if not exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
    ) then
      raise exception 'only an admin can change profiles.role'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_block_role_change
  before update of role on public.profiles
  for each row
  execute function public.profiles_block_role_change();
