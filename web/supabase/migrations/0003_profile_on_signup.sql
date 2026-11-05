-- 0003_profile_on_signup.sql  (issue 03-sign-in)
-- On first sign-in (Google or email code) Supabase inserts into auth.users.
-- This trigger mirrors that into public.profiles with role 'student'.
--
-- Why a trigger and not an API insert: 0002 has no insert policy on purpose,
-- so a signed-in user can never create or re-create a profile row. The row is
-- created by the platform, inside the same transaction as the auth user, which
-- means the app never has to check "does my profile exist yet".

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
-- SECURITY DEFINER so the insert runs as the function owner. The trigger fires
-- in the auth service's transaction, which has no rights on public.profiles.
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  -- Idempotent: a platform retry or a re-run of the hook must not raise.
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'Creates the public.profiles row for a new auth user (role student). Issue 03-sign-in.';

-- Only the platform may call it. Revoke from the API roles so a signed-in user
-- cannot run it to mint a row for somebody else.
revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.handle_new_auth_user() from anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_auth_user();
