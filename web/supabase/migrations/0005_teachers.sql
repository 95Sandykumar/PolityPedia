-- 0005_teachers.sql  (issue 05-teacher-invite-approval)
--
-- Teacher signup is invite only and an admin approves it (V1, F-A1).
--
-- THE PRIVACY RULE (v0, kept by V1 and PRD F-A5): a student never sees the
-- real name of a teacher who is in alias mode. That is enforced HERE, in the
-- database, not in a page:
--
--   * `public.teachers` holds the real name and has NO select policy for a
--     student, so the column cannot leave Postgres for them at all.
--   * `public.teachers_public` is the only thing a student reads. The view
--     runs with the OWNER's rights (no `security_invoker`), picks alias or
--     real name with a CASE, and does not even have a `real_name` column.
--
-- V19: `revenue_share_pct` is per teacher, admin-set, default 50. A teacher
-- cannot move their own share or approve themselves: the trigger at the bottom
-- blocks both, the same shape as 0002's role guard.

-- ---------------------------------------------------------------------------
-- Shared admin check.
--
-- `create or replace` with the SAME body as 0021_entitlements.sql on purpose.
-- Migrations run in file-name order, so 0005 runs first and cannot assume
-- 0021 exists; and an RLS policy expression is parsed when the policy is
-- created, so the function has to be there already. Replacing it later with
-- an identical definition is a no-op, so either order ends up the same.
--
-- SECURITY DEFINER so the lookup is not itself filtered by the profiles
-- policies. It only reads auth.uid()'s own row and returns a boolean.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
$$;

comment on function public.is_admin() is
  'True when the signed-in caller has profiles.role = admin. Issues 05-teacher-invite-approval and 21-plans-entitlements define this identically.';

grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- teachers
-- ---------------------------------------------------------------------------
create table if not exists public.teachers (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  identity_mode     text        not null default 'alias',
  real_name         text,
  alias             text,
  photo_path        text,
  alias_avatar      text,
  bio_en            text,
  bio_hi            text,
  status            text        not null default 'pending',
  approved_by       uuid        references auth.users (id) on delete set null,
  videos_visible    boolean     not null default true,
  revenue_share_pct integer     not null default 50,
  created_at        timestamptz not null default now(),
  constraint teachers_identity_mode_check check (identity_mode in ('public', 'alias')),
  constraint teachers_status_check        check (status in ('pending', 'approved')),
  constraint teachers_share_range_check   check (revenue_share_pct between 0 and 100)
);

comment on table public.teachers is
  'One row per teacher. RLS: own row plus admin. A student reads teachers_public instead, which never carries real_name. Issue 05-teacher-invite-approval.';
comment on column public.teachers.identity_mode is
  'alias = a student sees alias + alias_avatar only (v0 privacy rule). public = the teacher chose to show real_name + photo_path.';
comment on column public.teachers.real_name is
  'Never exposed to a student in alias mode. Not a column of teachers_public.';
comment on column public.teachers.status is
  'pending until an admin approves. The middleware keeps a pending teacher out of /teacher.';
comment on column public.teachers.videos_visible is
  'V6: the teacher decides whether their YouTube videos tile shows at all.';
comment on column public.teachers.revenue_share_pct is
  'V19: per-teacher share of their own mock set sales. Admin-set, default 50.';

-- The student-facing list is "approved teachers", so index that filter.
create index if not exists teachers_status_idx on public.teachers (status);

alter table public.teachers enable row level security;

-- A teacher reads and edits their OWN row, real name included: it is theirs.
create policy teachers_select_own on public.teachers
  for select to authenticated
  using (auth.uid() = user_id);

create policy teachers_update_own on public.teachers
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- An admin reads and writes every row: that is the approval screen.
create policy teachers_admin_all on public.teachers
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- No insert policy for a user on purpose. A row is created by
-- `redeem_teacher_invite()` (below) or by an admin, never by an API insert,
-- so nobody can declare themselves a teacher.

-- ---------------------------------------------------------------------------
-- teachers_public: the ONLY teacher data a student may read.
--
-- No `security_invoker`, so the view runs with the owner's rights and the
-- `teachers` policies do not apply to it. DO NOT add
-- `with (security_invoker = true)`: that would make the view read as the
-- student, who has no select policy, and every portfolio page would go blank.
--
-- `security_barrier` stops a cheap trick where a user-supplied function in the
-- WHERE clause runs before the view's own filter and sees hidden rows.
-- ---------------------------------------------------------------------------
create or replace view public.teachers_public with (security_barrier = true) as
select
  t.user_id,
  t.identity_mode,
  case when t.identity_mode = 'public' then t.real_name  else t.alias        end as display_name,
  case when t.identity_mode = 'public' then t.photo_path else t.alias_avatar end as avatar_path,
  t.bio_en,
  t.bio_hi,
  t.videos_visible
from public.teachers t
where t.status = 'approved';

comment on view public.teachers_public is
  'Student-facing teacher list. Alias mode returns alias + alias_avatar only; real_name and photo_path are not columns here. Approved teachers only. Issue 05-teacher-invite-approval.';

-- A one-table view is auto-updatable, and this one runs as its owner, so a
-- plain `grant all` (Supabase default privileges) would let a student write
-- another teacher's bio with RLS bypassed. Read-only, explicitly.
revoke all on public.teachers_public from anon, authenticated;
grant select on public.teachers_public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- teacher_invites
--
-- Only an admin can see or make a code. A candidate never selects this table;
-- they call `redeem_teacher_invite()` with the code they were sent, so the
-- codes cannot be listed and guessed.
-- ---------------------------------------------------------------------------
create table if not exists public.teacher_invites (
  code       text primary key,
  created_by uuid        references auth.users (id) on delete set null,
  used_by    uuid        references auth.users (id) on delete set null,
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  constraint teacher_invites_code_check check (length(btrim(code)) between 4 and 64),
  -- used_by and used_at are set together or not at all.
  constraint teacher_invites_used_check check ((used_by is null) = (used_at is null))
);

comment on table public.teacher_invites is
  'Single-use teacher invite codes. RLS: admin only; a candidate redeems through redeem_teacher_invite(). Issue 05-teacher-invite-approval.';

alter table public.teacher_invites enable row level security;

create policy teacher_invites_admin_all on public.teacher_invites
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 0002's role guard, widened by one case.
--
-- Same rule for an API caller: only an admin may change profiles.role. What is
-- new is that a PLATFORM path may: a SECURITY DEFINER function (like
-- `redeem_teacher_invite` below), the service role used by webhooks, or a
-- migration. Those do not run as `anon` or `authenticated`, and a signed-in
-- user cannot become another database role, so this is not a way in.
--
-- SECURITY INVOKER (the default), unlike 0002's version, because the whole
-- check now rests on `current_user`: inside a SECURITY DEFINER function
-- `current_user` is the function owner, and the trigger would wave everything
-- through. The admin lookup still works, because `is_admin()` is the
-- SECURITY DEFINER part.
-- ---------------------------------------------------------------------------
create or replace function public.profiles_block_role_change()
returns trigger
language plpgsql
set search_path = public, auth, pg_temp
as $$
begin
  if new.role is distinct from old.role then
    if current_user in ('anon', 'authenticated') and not public.is_admin() then
      raise exception 'only an admin can change profiles.role'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Redeem an invite code.
--
-- SECURITY DEFINER because it has to do three things the caller may not: read
-- `teacher_invites`, insert into `teachers`, and set `profiles.role`.
--
-- Single use is the UPDATE's own `where used_by is null`. Postgres takes the
-- row lock, so if two people submit the same code at the same moment exactly
-- one UPDATE returns a row and the other gets the error below. No extra lock
-- and no race.
--
-- The whole function is one transaction: a failure anywhere leaves the code
-- unused and the caller a student.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_teacher_invite(code text)
returns void
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  caller  uuid := auth.uid();
  claimed text;
begin
  if caller is null then
    raise exception 'sign in before redeeming an invite code'
      using errcode = '42501';
  end if;

  -- Already a teacher: do not let them burn a second code.
  if exists (select 1 from public.teachers t where t.user_id = caller) then
    raise exception 'this account is already a teacher'
      using errcode = '42501';
  end if;

  update public.teacher_invites i
     set used_by = caller,
         used_at = now()
   where i.code = btrim(redeem_teacher_invite.code)
     and i.used_by is null
  returning i.code into claimed;

  if claimed is null then
    raise exception 'invite code is not valid'
      using errcode = '22023';
  end if;

  -- Pending on purpose. An admin approves (F-A1), and until then the
  -- middleware keeps them out of the teacher pages.
  insert into public.teachers (user_id, identity_mode, status)
  values (caller, 'alias', 'pending');

  -- Routing role only. Every read is still decided by RLS.
  update public.profiles
     set role = 'teacher'
   where id = caller
     and role = 'student';
end;
$$;

comment on function public.redeem_teacher_invite(text) is
  'Spends a single-use invite code: makes the caller a pending teacher and sets profiles.role = teacher. Issue 05-teacher-invite-approval.';

revoke all on function public.redeem_teacher_invite(text) from public;
revoke all on function public.redeem_teacher_invite(text) from anon;
grant execute on function public.redeem_teacher_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- V19 guard: `status`, `revenue_share_pct` and `approved_by` are admin-only.
--
-- An RLS `with check` cannot do this, because it cannot see the OLD row, so a
-- trigger compares them. Same shape as 0002's role guard, and the same
-- platform exception: a definer function or the service role may write them.
--
-- SECURITY INVOKER (the default) is required: `current_user` has to be the
-- caller's role, and a SECURITY DEFINER function would report the owner.
-- ---------------------------------------------------------------------------
create or replace function public.teachers_block_admin_fields()
returns trigger
language plpgsql
set search_path = public, auth, pg_temp
as $$
begin
  if new.status            is distinct from old.status
  or new.revenue_share_pct is distinct from old.revenue_share_pct
  or new.approved_by       is distinct from old.approved_by then
    if current_user in ('anon', 'authenticated') and not public.is_admin() then
      raise exception 'only an admin can set teachers.status, revenue_share_pct or approved_by'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.teachers_block_admin_fields() is
  'V19: blocks a teacher from changing their own status, revenue share or approver. Issue 05-teacher-invite-approval.';

drop trigger if exists teachers_block_admin_fields on public.teachers;

create trigger teachers_block_admin_fields
  before update on public.teachers
  for each row
  execute function public.teachers_block_admin_fields();
