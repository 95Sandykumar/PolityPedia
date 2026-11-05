-- 0011_questions.sql  (issue 11-ingest-job-review-publish)
--
-- V9 PDF split: the AI cuts a paper PDF into questions, the teacher reviews
-- each one, fixes it, marks it Checked, and publishes. NOTHING IS LIVE BEFORE
-- TEACHER PUBLISH. Risk 1 in design.md is the same rule read backwards: a
-- wrong answer out of the split must not reach a student before a teacher has
-- looked at it.
--
-- Two tables and one function:
--
--  * `ingest_jobs` -- one row per PDF handed to the splitter. The teacher's
--    review screen watches this row over Realtime, so the progress is PUSHED
--    and nothing polls (design check B6).
--  * `questions`   -- the split output, and later the mock-test questions.
--  * `publish_paper(paper_id)` -- the one way a paper goes live.
--
-- WHERE THE GUARANTEE LIVES. Three layers, each of which alone would be
-- enough to keep a draft away from a student, because one of them will have a
-- bug one day:
--
--  1. `questions_live_is_checked_check`: a row can be `live` only when
--     `checked` is true. Not a policy, a CHECK: no UPDATE anywhere in the app,
--     and no mistake in the splitter, can produce a live unchecked question.
--  2. `questions_select_live`: a student is only ever handed `live` rows of an
--     APPROVED teacher.
--  3. `publish_paper()`: refuses the whole paper while ONE question is
--     unchecked, or while the split job is still queued or running.
--
-- STORAGE. `pdf_path` and `image_path` are object paths inside Supabase
-- Storage buckets, never bytes in a column, and the buckets themselves are
-- platform config like `auth.users`, so they are not created here (web/CLAUDE.md).
--
-- `test_id` HAS NO FOREIGN KEY YET. Mock tests are issue 15; this file would
-- fail against a database that has no `tests` table, so the column is a plain
-- uuid for now and issue 15 adds the reference.

-- --------------------------------------------------------------------------
-- A composite key on `papers`, so a question cannot be hung on a paper that
-- belongs to somebody else.
--
-- `papers.id` is already unique on its own, so this index adds no new rule to
-- `papers`. It exists only because a composite FOREIGN KEY needs a unique
-- index over exactly the columns it points at, and (teacher_id, paper_id) in
-- `questions` is the pair we want Postgres to verify. Without it, teacher A
-- could insert a question whose `paper_id` is teacher B's paper; RLS would
-- still hide it, but the row would exist, and a later join would be wrong.
-- --------------------------------------------------------------------------
create unique index if not exists papers_owner_id_idx
  on public.papers (teacher_id, id);

-- --------------------------------------------------------------------------
-- ingest_jobs
-- --------------------------------------------------------------------------
create table if not exists public.ingest_jobs (
  id             uuid        primary key default gen_random_uuid(),
  teacher_id     uuid        not null references public.teachers (user_id) on delete cascade,
  paper_id       uuid        not null,
  pdf_path       text        not null,
  status         text        not null default 'queued',
  attempts       integer     not null default 0,
  error          text,
  question_count integer     not null default 0,
  created_at     timestamptz not null default now(),

  -- Same composite reference as `questions` below: a job belongs to its own
  -- teacher's paper or to no paper at all.
  constraint ingest_jobs_paper_fkey
    foreign key (teacher_id, paper_id)
    references public.papers (teacher_id, id) on delete cascade,

  constraint ingest_jobs_status_check
    check (status in ('queued', 'running', 'done', 'failed')),
  -- design.md: 3 retries, then `failed` with the error shown to the teacher.
  constraint ingest_jobs_attempts_check check (attempts between 0 and 3),
  -- F-D2: 200 questions per PDF.
  constraint ingest_jobs_count_check    check (question_count between 0 and 200),
  constraint ingest_jobs_pdf_path_check check (length(btrim(pdf_path)) > 0)
);

comment on table public.ingest_jobs is
  'One PDF split job (V9). The teacher review screen watches its own row over Realtime, so progress is pushed and nothing polls (B6). RLS: a teacher sees only their own jobs. Issue 11-ingest-job-review-publish.';
comment on column public.ingest_jobs.status is
  'queued -> running -> done, or failed after 3 attempts. The worker (P9) moves it with the service role, which bypasses RLS.';
comment on column public.ingest_jobs.error is
  'Why the split failed, shown to the teacher as-is. Never a stack trace.';
comment on column public.ingest_jobs.question_count is
  'How many questions the split produced so far, for the live "42 questions found" line.';

-- The review screen asks "the job for this paper, newest first".
create index if not exists ingest_jobs_paper_idx
  on public.ingest_jobs (paper_id, created_at desc);

-- The worker asks "anything still queued", oldest first.
create index if not exists ingest_jobs_queue_idx
  on public.ingest_jobs (status, created_at)
  where status in ('queued', 'running');

alter table public.ingest_jobs enable row level security;

-- A job is plumbing, not content, so NOBODY but its own teacher reads it.
-- A student has no business knowing that a split failed twice.
create policy ingest_jobs_select_own on public.ingest_jobs
  for select to authenticated
  using (auth.uid() = teacher_id);

create policy ingest_jobs_insert_own on public.ingest_jobs
  for insert to authenticated
  with check (auth.uid() = teacher_id);

-- The teacher may retry their own job (set it back to `queued`). The worker
-- itself runs with the service role and bypasses RLS entirely.
create policy ingest_jobs_update_own on public.ingest_jobs
  for update to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy ingest_jobs_delete_own on public.ingest_jobs
  for delete to authenticated
  using (auth.uid() = teacher_id);

-- --------------------------------------------------------------------------
-- questions
-- --------------------------------------------------------------------------
create table if not exists public.questions (
  id                  uuid        primary key default gen_random_uuid(),
  teacher_id          uuid        not null references public.teachers (user_id) on delete cascade,
  -- Exactly one of these two is set. A past-paper question hangs on a paper,
  -- a mock-test question on a test.
  paper_id            uuid,
  test_id             uuid,
  number              integer     not null,
  stem                text        not null,
  options             jsonb       not null,
  correct_idx         integer     not null,
  teacher_explanation text,
  topic_id            uuid,
  lang                text        not null default 'en',
  image_path          text,
  checked             boolean     not null default false,
  status              text        not null default 'draft',
  created_at          timestamptz not null default now(),

  constraint questions_paper_fkey
    foreign key (teacher_id, paper_id)
    references public.papers (teacher_id, id) on delete cascade,

  -- `<>` on two booleans is XOR: exactly one of the two parents.
  constraint questions_one_parent_check
    check ((paper_id is not null) <> (test_id is not null)),

  -- F-D2: 200 questions per PDF, so the number cannot run past it.
  constraint questions_number_check check (number between 1 and 200),
  constraint questions_stem_check   check (length(btrim(stem)) > 0),

  -- EXACTLY 4 options, each a filled-in string. The AI returns this shape and
  -- the player draws four buttons A to D, so three or five options is not a
  -- question, it is a bad split.
  --
  -- The jsonpath asks "is there any element that is not a string, or is an
  -- empty one"; the constraint holds when there is not.
  constraint questions_options_check check (
    jsonb_typeof(options) = 'array'
    and jsonb_array_length(options) = 4
    and not (options @? '$[*] ? (@.type() != "string" || @ == "")')
  ),

  constraint questions_correct_idx_check check (correct_idx between 0 and 3),
  constraint questions_lang_check        check (lang in ('en', 'hi')),
  constraint questions_status_check      check (status in ('draft', 'live')),

  -- V9, the hard one. A live question has been checked by its teacher. Full
  -- stop. This is why a bug in a route handler cannot put a raw AI answer in
  -- front of a student (Risk 1).
  constraint questions_live_is_checked_check
    check (status = 'draft' or checked)
);

comment on table public.questions is
  'Questions from the PDF split (V9) and later from mock tests (V10). A row is an unchecked draft until its teacher checks it, and `questions_live_is_checked_check` makes "live and unchecked" impossible. RLS: the teacher writes their own; any signed-in user reads an approved teacher''s LIVE rows. Issue 11-ingest-job-review-publish.';
comment on column public.questions.test_id is
  'Mock test this question belongs to. Plain uuid for now: the FK to `tests` arrives with issue 15.';
comment on column public.questions.options is
  'Exactly four non-empty strings, in A B C D order. The player draws one button per element.';
comment on column public.questions.correct_idx is
  '0 to 3, an index into `options`. Not a letter: a letter would need parsing in two languages.';
comment on column public.questions.checked is
  'The teacher has read this question next to its PDF page and is happy with it (F-D3).';
comment on column public.questions.status is
  'draft until publish_paper(). A student only ever reads live rows.';

-- One question number per paper: the split must not leave "question 7" twice.
-- Partial, because a mock-test question has no paper_id and many of them would
-- otherwise collide on NULL.
create unique index if not exists questions_paper_number_idx
  on public.questions (paper_id, number)
  where paper_id is not null;

-- The review screen reads "this paper's questions in order", and the publish
-- gate reads "any unchecked ones".
create index if not exists questions_review_idx
  on public.questions (paper_id, number)
  where paper_id is not null;

create index if not exists questions_test_number_idx
  on public.questions (test_id, number)
  where test_id is not null;

alter table public.questions enable row level security;

-- READ. The teacher sees everything of their own, drafts included, because
-- that is the review screen. Anybody else only ever gets a `live` row of an
-- APPROVED teacher.
--
-- The subquery hits `public.teachers_public`, NOT `public.teachers`: a policy
-- subquery runs as the caller, a student has no select policy on `teachers`,
-- so a subquery over the table would always come back empty. `teachers_public`
-- is an owner-rights view that already filters `status = 'approved'` (0005).
create policy questions_select_live on public.questions
  for select to authenticated
  using (
    auth.uid() = teacher_id
    or (
      status = 'live'
      and exists (
        select 1
        from public.teachers_public tp
        where tp.user_id = questions.teacher_id
      )
    )
  );

create policy questions_insert_own on public.questions
  for insert to authenticated
  with check (auth.uid() = teacher_id);

-- Both halves are needed: without `with check`, an update could rewrite
-- `teacher_id` and hand the question to another teacher.
create policy questions_update_own on public.questions
  for update to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy questions_delete_own on public.questions
  for delete to authenticated
  using (auth.uid() = teacher_id);

-- --------------------------------------------------------------------------
-- publish_paper(paper_id) -- the ONLY way a paper and its questions go live.
-- --------------------------------------------------------------------------
--
-- Returns how many questions it published.
--
-- SECURITY INVOKER (the default) on purpose: both UPDATEs run through the
-- CALLER's own RLS, so there is no second permission model to keep in step
-- with the policies above. A function body is one transaction, so the paper
-- and its questions move together or not at all; a RAISE rolls the whole thing
-- back, which is what "atomically" in the issue means.
--
-- plpgsql, not sql, so the parameter can be written `publish_paper.paper_id`.
-- In a LANGUAGE SQL body a bare `paper_id` would silently resolve to the
-- COLUMN and the filter would match every row.
create or replace function public.publish_paper(paper_id uuid)
returns integer
language plpgsql
volatile
as $$
declare
  owner      uuid;
  unchecked  integer;
  busy       integer;
  published  integer;
begin
  -- RLS applies here, so a paper the caller may not even read comes back NULL
  -- and is reported as "not found", never as "not yours".
  select p.teacher_id into owner
  from public.papers p
  where p.id = publish_paper.paper_id;

  if owner is null then
    raise exception 'paper not found'
      using errcode = 'no_data_found';
  end if;

  -- A student can READ a live paper, so the ownership check is a separate
  -- question from the read above.
  if owner <> auth.uid() then
    raise exception 'paper belongs to another teacher'
      using errcode = 'insufficient_privilege';
  end if;

  -- Risk 1: a split that is still running means questions are still arriving,
  -- and the teacher cannot have checked what is not there yet.
  select count(*) into busy
  from public.ingest_jobs j
  where j.paper_id = publish_paper.paper_id
    and j.status in ('queued', 'running');

  if busy > 0 then
    raise exception 'the split is still running'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- F-D3: publish stays off until every question is checked.
  select count(*) into unchecked
  from public.questions q
  where q.paper_id = publish_paper.paper_id
    and not q.checked;

  if unchecked > 0 then
    raise exception 'paper has % unchecked question(s)', unchecked
      using errcode = 'check_violation';
  end if;

  -- Questions FIRST, then the paper. If the question update were to fail, the
  -- paper would never have been flipped, so a student can never reach a live
  -- paper whose questions are still drafts.
  update public.questions q
  set status = 'live'
  where q.paper_id = publish_paper.paper_id;
  get diagnostics published = row_count;

  update public.papers p
  set status = 'live'
  where p.id = publish_paper.paper_id;

  return published;
end;
$$;

comment on function public.publish_paper(uuid) is
  'Publish one past paper: refuses while the split job runs or any question is unchecked, then sets the questions and the paper live in one transaction. SECURITY INVOKER, so RLS decides. Issue 11-ingest-job-review-publish.';

grant execute on function public.publish_paper(uuid) to authenticated;

-- A paper with NO questions is allowed to go live: the PDF itself is content
-- (issue 10 shipped the download before the split existed), and "every
-- question is checked" is trivially true when there are none.
