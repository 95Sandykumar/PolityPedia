-- 0006_follows.sql  (issue 06-portfolio-follow)
--
-- Follow is FREE (PRD F-A2, renamed from Subscribe in v0). So this table does
-- not carry money, a plan or a date range: it is one row per (student,
-- teacher) pair and nothing else.
--
-- The rule is the strictest in the app: a row belongs to exactly ONE student,
-- so every policy is `auth.uid() = user_id`. A student can never see, add or
-- drop somebody else's follow.
--
-- WHO MAY BE FOLLOWED. A student only ever sees APPROVED teachers (issue 05),
-- so a follow of a pending teacher would be a row the student could not have
-- made from the UI. The insert policy refuses it.
--
-- It checks `public.teachers_public`, NOT `public.teachers`. A policy subquery
-- runs as the caller, and a student has no select policy on `teachers`, so a
-- subquery over the table would always come back empty and block every
-- follow. `teachers_public` is a view with the OWNER's rights (0005) and it
-- already filters `status = 'approved'`, which is exactly the question being
-- asked. 0005 runs first (file-name order), so the view is there.

create table if not exists public.follows (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  teacher_id uuid        not null references public.teachers (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, teacher_id)
);

comment on table public.follows is
  'Which teachers one student follows. Free (PRD F-A2). RLS: own rows only. Issue 06-portfolio-follow.';
comment on column public.follows.teacher_id is
  'References teachers.user_id, so a non-teacher cannot be followed. The insert policy adds "and approved".';

-- "Who follows this teacher" is the notification fan-out (issue 09). The
-- student's own list is read by user_id, which the primary key already covers.
create index if not exists follows_teacher_id_idx on public.follows (teacher_id);

alter table public.follows enable row level security;

create policy follows_select_own on public.follows
  for select to authenticated
  using (auth.uid() = user_id);

create policy follows_insert_own on public.follows
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.teachers_public tp
      where tp.user_id = follows.teacher_id
    )
  );

create policy follows_delete_own on public.follows
  for delete to authenticated
  using (auth.uid() = user_id);

-- No update policy: both columns are the primary key, so a change is a delete
-- plus an insert, and both of those are covered above. Same shape as
-- `student_exams` in 0004.
