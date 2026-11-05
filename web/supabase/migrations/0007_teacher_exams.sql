-- 0007_teacher_exams.sql  (issue 07-next-exam-date-teacher-shell)
--
-- V7: each teacher keeps the next exam date PER EXAM. There is no platform
-- wide exam calendar on purpose: PGT and TGT notices come out on irregular
-- dates per state, so the teacher who runs the batch is the only person who
-- knows the real date (PRD section 5).
--
-- The row owner is the TEACHER, so every write policy is
-- `auth.uid() = teacher_id`. Teacher A can never touch teacher B's dates.
--
-- READ is wider, because the date is public on the portfolio: any signed-in
-- user reads the rows of an APPROVED teacher, plus their own rows whatever
-- their status is.
--
-- It checks `public.teachers_public`, NOT `public.teachers`. A policy subquery
-- runs as the caller, and a student has no select policy on `teachers`, so a
-- subquery over the table would always come back empty and the pill would
-- never show. `teachers_public` is a view with the OWNER's rights (0005) and
-- it already filters `status = 'approved'`, which is exactly the question
-- being asked. 0005 runs first (file-name order), so the view is there.
--
-- `next_exam_date` is nullable on purpose. A teacher can list the exam they
-- teach before the exam body has published a date; NULL means "not announced",
-- which is different from a date in the past. The pill simply does not show.

create table if not exists public.teacher_exams (
  teacher_id     uuid        not null references public.teachers (user_id) on delete cascade,
  exam_id        uuid        not null references public.exams (id) on delete cascade,
  next_exam_date date,
  label          text,
  created_at     timestamptz not null default now(),
  primary key (teacher_id, exam_id),
  -- A short name for the pill ("NET"), not a sentence: the pill is one line on
  -- a 360 px phone (DESIGN.md section 5). Blank is stored as NULL, never ''.
  constraint teacher_exams_label_check
    check (label is null or length(btrim(label)) between 1 and 24)
);

comment on table public.teacher_exams is
  'Per-teacher next exam date (V7). One row per (teacher, exam). RLS: the teacher writes their own rows; any signed-in user reads an approved teacher''s rows. Issue 07-next-exam-date-teacher-shell.';
comment on column public.teacher_exams.next_exam_date is
  'The teacher''s own next date for this exam. NULL = not announced yet, which is not the same as a past date. Also drives X2 (how long a bought set stays open).';
comment on column public.teacher_exams.label is
  'Short name for the portfolio pill, e.g. NET in "Next exam: NET 18 Dec". NULL falls back to the exam name.';

-- "Which teachers run this exam" is the other direction (issues 08 to 11).
-- The teacher's own list is read by teacher_id, which the primary key covers.
create index if not exists teacher_exams_exam_id_idx on public.teacher_exams (exam_id);

alter table public.teacher_exams enable row level security;

create policy teacher_exams_select_public on public.teacher_exams
  for select to authenticated
  using (
    auth.uid() = teacher_id
    or exists (
      select 1
      from public.teachers_public tp
      where tp.user_id = teacher_exams.teacher_id
    )
  );

create policy teacher_exams_insert_own on public.teacher_exams
  for insert to authenticated
  with check (auth.uid() = teacher_id);

-- `using` picks the rows that may be touched, `with check` the rows that may
-- be left behind. Both are needed: without the check an update could rewrite
-- `teacher_id` and hand the row to somebody else.
create policy teacher_exams_update_own on public.teacher_exams
  for update to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy teacher_exams_delete_own on public.teacher_exams
  for delete to authenticated
  using (auth.uid() = teacher_id);

-- No admin policy. An admin approves a teacher and sets their revenue share
-- (0005); the exam date is the teacher's own call, so nobody else writes it.
