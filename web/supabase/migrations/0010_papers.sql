-- 0010_papers.sql  (issue 10-papers-upload-browse)
--
-- V8: past papers are PER TEACHER and free for every student. Each teacher
-- keeps their OWN copy of a paper and their own explanations, so the row owner
-- is the TEACHER and only that teacher may edit it (PRD F-D1).
--
-- The path a student walks is Exam > Year > Month (optional) > PDF, which is
-- exactly the four columns below. `month` is NULL when the paper is only known
-- by its year ("UGC NET 2024"), which is different from a month of 1.
--
-- A paper carries up to two PDFs: the questions, the solutions, or both
-- (PRD F-D1). At least one must be there, or there is nothing to download.
--
-- STATUS. A new paper is a `draft`, and a student never sees a draft: the
-- select policy below only hands out `live` rows. Nothing flips a row to
-- `live` in this issue; the publish button is issue 11, after the AI split and
-- the teacher's review (PRD F-D3, "nothing goes live before publish").
--
-- STORAGE. The PDFs live in a Supabase Storage bucket (`papers`), not in a
-- column: the columns hold the object PATH. The bucket and its storage
-- policies are platform config, like `auth.users`, so they are NOT created
-- here; this file would then fail against the PGlite test harness, which has
-- no `storage` schema (web/CLAUDE.md). The app reaches storage through the
-- `FileStore` interface in `src/lib/papers/types.ts`, which is faked in tests.
--
-- READ is wider than write, because a past paper is free: any signed-in user
-- reads the LIVE papers of an APPROVED teacher, plus every one of their own
-- rows whatever the status.
--
-- It checks `public.teachers_public`, NOT `public.teachers`. A policy subquery
-- runs as the caller, and a student has no select policy on `teachers`, so a
-- subquery over the table would always come back empty and the list would
-- always be blank. `teachers_public` is a view with the OWNER's rights (0005)
-- and it already filters `status = 'approved'`, which is exactly the question
-- being asked. 0005 runs first (file-name order), so the view is there.

create table if not exists public.papers (
  id                 uuid        primary key default gen_random_uuid(),
  teacher_id         uuid        not null references public.teachers (user_id) on delete cascade,
  exam_id            uuid        not null references public.exams (id) on delete cascade,
  year               integer     not null,
  month              integer,
  label              text        not null,
  pdf_questions_path text,
  pdf_solutions_path text,
  status             text        not null default 'draft',
  created_at         timestamptz not null default now(),

  constraint papers_status_check check (status in ('draft', 'live')),
  constraint papers_year_check   check (year between 1950 and 2100),
  constraint papers_month_check  check (month is null or month between 1 and 12),
  -- A row name, not a sentence: it sits on one line of a 360 px phone
  -- (DESIGN.md section 5). Blank is refused, never stored as ''.
  constraint papers_label_check  check (length(btrim(label)) between 1 and 60),
  -- No PDF means nothing to download, which is not a paper.
  constraint papers_pdf_check
    check (pdf_questions_path is not null or pdf_solutions_path is not null),

  -- UNIQUE (teacher_id, exam_id, year, month, label), with NULLS NOT
  -- DISTINCT: by default Postgres treats two NULLs as different values, so
  -- "UGC NET 2024, no month, Shift 1" could be uploaded twice and the student
  -- would see the same paper twice. NULLS NOT DISTINCT (Postgres 15+) makes
  -- "no month" one value, which is what a teacher means by it.
  constraint papers_one_per_teacher
    unique nulls not distinct (teacher_id, exam_id, year, month, label)
);

comment on table public.papers is
  'Past papers, one row per (teacher, exam, year, month, label). V8: per teacher, free for students. RLS: the teacher writes their own rows; any signed-in user reads an approved teacher''s LIVE rows. Issue 10-papers-upload-browse.';
comment on column public.papers.month is
  'NULL when the paper is known by year only. Not the same as January.';
comment on column public.papers.label is
  'What the row is called in the list, e.g. "Shift 1" or "Paper II".';
comment on column public.papers.pdf_questions_path is
  'Object path inside the `papers` Storage bucket. NULL when the teacher uploaded solutions only.';
comment on column public.papers.pdf_solutions_path is
  'Object path inside the `papers` Storage bucket. NULL when the teacher uploaded questions only.';
comment on column public.papers.status is
  'draft until the teacher publishes (issue 11). A student only ever reads live rows.';

-- The student list is "this teacher's live papers, newest first", and the
-- teacher's own screen is "my papers". One index covers the lead columns of
-- both.
create index if not exists papers_browse_idx
  on public.papers (teacher_id, status, exam_id, year desc);

alter table public.papers enable row level security;

create policy papers_select_live on public.papers
  for select to authenticated
  using (
    auth.uid() = teacher_id
    or (
      status = 'live'
      and exists (
        select 1
        from public.teachers_public tp
        where tp.user_id = papers.teacher_id
      )
    )
  );

create policy papers_insert_own on public.papers
  for insert to authenticated
  with check (auth.uid() = teacher_id);

-- `using` picks the rows that may be touched, `with check` the rows that may
-- be left behind. Both are needed: without the check an update could rewrite
-- `teacher_id` and hand the paper to somebody else.
create policy papers_update_own on public.papers
  for update to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy papers_delete_own on public.papers
  for delete to authenticated
  using (auth.uid() = teacher_id);

-- No admin policy. An admin approves the teacher (0005); which papers that
-- teacher keeps is the teacher's own call.
