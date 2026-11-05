-- 0013_attempts.sql  (issue 13-question-player)
--
-- One sitting of a paper or a mock test, and one row per question in it.
--
--  * `attempts`        -- a student opened a paper and started answering.
--  * `attempt_answers` -- what they chose for each question, PK
--                         `(attempt_id, question_id)`.
--
-- WHY THE PRIMARY KEY IS THE WHOLE DESIGN (A1). The player writes straight
-- from the browser on a 4G connection that drops, and it keeps a retry queue,
-- so the SAME answer will be sent twice. `(attempt_id, question_id)` plus
-- `on conflict ... do update` makes that write IDEMPOTENT: the second send
-- rewrites the row, it never adds one. Without the key the student would see
-- "answered 118 of 100" and the score would be nonsense.
--
-- `chosen_idx` AND `is_correct` ARE NULLABLE on purpose. "Marked for later,
-- not answered yet" is a real state in the player (DESIGN.md section 8), and
-- it has no chosen option, so it can have no verdict either. A zero or a false
-- there would read as "answered option A, wrong".
--
-- `is_correct` IS STORED, not computed on read. A teacher may fix a wrong
-- `correct_idx` on a live question later; the score a student already saw must
-- not change under them. The verdict is of the moment they answered.
--
-- `test_id` HAS NO FOREIGN KEY YET, the same as in 0011: mock tests are issue
-- 15, and this file would fail against a database with no `tests` table.
-- Practice and exam mode for mocks are issues 17 and 18; the `mode` and
-- `deadline_at` columns exist here because the player component is shared and
-- the schema must not need a migration to grow a timer.
--
-- PRIVACY. An attempt is a student's score. NOBODY else reads it: not another
-- student, and not the teacher who owns the paper. Teacher reporting over
-- batches is a later issue and will go through an owner-rights view, the way
-- `teachers_public` does in 0005, never by widening these policies.

-- --------------------------------------------------------------------------
-- attempts
-- --------------------------------------------------------------------------
create table if not exists public.attempts (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  -- Exactly one of these two is set: a past paper, or a mock test.
  paper_id     uuid        references public.papers (id) on delete cascade,
  test_id      uuid,
  mode         text        not null default 'practice',
  -- Set when the student picked one topic instead of the full paper
  -- (DESIGN.md section 8: "Full paper by default").
  topic_id     uuid,
  started_at   timestamptz not null default now(),
  -- Exam mode only: when the timer runs out. NULL in practice mode, which is
  -- what "no timer" means, so there is no magic date to check for.
  deadline_at  timestamptz,
  -- NULL while the sitting is open. Set once, when the student submits.
  submitted_at timestamptz,
  -- Marks, not a count of right answers: negative marking makes them
  -- different numbers. NULL until the attempt is submitted and scored.
  score        integer,

  -- `<>` on two booleans is XOR: exactly one of the two parents.
  constraint attempts_one_parent_check
    check ((paper_id is not null) <> (test_id is not null)),

  constraint attempts_mode_check check (mode in ('practice', 'exam')),

  -- A deadline before the start would show a timer that is already over.
  constraint attempts_deadline_check
    check (deadline_at is null or deadline_at > started_at)
);

comment on table public.attempts is
  'One sitting of a past paper or a mock test by one student. RLS: own rows only, because an attempt is the student''s score and nobody else''s business. Issue 13-question-player.';
comment on column public.attempts.mode is
  'practice (answer and see the result at once) or exam (timer, result at the end). Mock-test modes are issues 17 and 18; the player component is shared.';
comment on column public.attempts.deadline_at is
  'Exam mode only: when the timer runs out. NULL in practice mode.';
comment on column public.attempts.score is
  'Marks after negative marking, not the number of right answers. NULL until submitted.';

-- "My attempts at this paper, newest first": the Resume / Review row.
create index if not exists attempts_user_paper_idx
  on public.attempts (user_id, paper_id, started_at desc)
  where paper_id is not null;

create index if not exists attempts_user_test_idx
  on public.attempts (user_id, test_id, started_at desc)
  where test_id is not null;

alter table public.attempts enable row level security;

create policy attempts_select_own on public.attempts
  for select to authenticated
  using (auth.uid() = user_id);

create policy attempts_insert_own on public.attempts
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Both halves: without `with check`, an update could rewrite `user_id` and
-- hand the attempt (and its score) to somebody else.
create policy attempts_update_own on public.attempts
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy attempts_delete_own on public.attempts
  for delete to authenticated
  using (auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- attempt_answers
-- --------------------------------------------------------------------------
create table if not exists public.attempt_answers (
  attempt_id  uuid        not null references public.attempts (id) on delete cascade,
  question_id uuid        not null references public.questions (id) on delete cascade,
  -- NULL = not answered (marked for later). 0 to 3, an index into
  -- `questions.options`, never a letter.
  chosen_idx  integer,
  -- NULL = not answered. Stored, not computed: see the header.
  is_correct  boolean,
  marked      boolean     not null default false,
  answered_at timestamptz not null default now(),

  -- A1: this is what makes the player's write safe to repeat.
  constraint attempt_answers_pkey primary key (attempt_id, question_id),

  constraint attempt_answers_chosen_idx_check
    check (chosen_idx is null or chosen_idx between 0 and 3),

  -- A verdict without a chosen option is a bug upstream, not a state.
  constraint attempt_answers_verdict_check
    check ((chosen_idx is null) = (is_correct is null))
);

comment on table public.attempt_answers is
  'One answer in one sitting. PK (attempt_id, question_id) makes the player''s upsert idempotent (A1), which is what lets the offline retry queue send the same answer twice. RLS: reachable only through an attempt the caller owns. Issue 13-question-player.';
comment on column public.attempt_answers.chosen_idx is
  'NULL when the question is only marked for later. Otherwise 0 to 3, an index into questions.options.';
comment on column public.attempt_answers.is_correct is
  'The verdict at the moment of answering. Stored, so a teacher fixing correct_idx later cannot move a score the student already saw.';
comment on column public.attempt_answers.marked is
  'Mark for later (DESIGN.md section 8). Independent of answering: a student can mark an answered question too.';

-- "The questions I marked in this sitting", for the question-number grid.
create index if not exists attempt_answers_marked_idx
  on public.attempt_answers (attempt_id)
  where marked;

alter table public.attempt_answers enable row level security;

-- The owner comes from the PARENT, so there is one place that decides who owns
-- an answer. `attempts_select_own` is not enough on its own: a policy
-- subquery runs as the caller, so the EXISTS below is itself filtered by that
-- policy, and the two agree by construction.
create policy attempt_answers_select_own on public.attempt_answers
  for select to authenticated
  using (
    exists (
      select 1 from public.attempts a
      where a.id = attempt_answers.attempt_id and a.user_id = auth.uid()
    )
  );

create policy attempt_answers_insert_own on public.attempt_answers
  for insert to authenticated
  with check (
    exists (
      select 1 from public.attempts a
      where a.id = attempt_answers.attempt_id and a.user_id = auth.uid()
    )
  );

-- `on conflict ... do update` needs BOTH insert and update to be allowed, so
-- the upsert in the player would fail without this policy.
create policy attempt_answers_update_own on public.attempt_answers
  for update to authenticated
  using (
    exists (
      select 1 from public.attempts a
      where a.id = attempt_answers.attempt_id and a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.attempts a
      where a.id = attempt_answers.attempt_id and a.user_id = auth.uid()
    )
  );

create policy attempt_answers_delete_own on public.attempt_answers
  for delete to authenticated
  using (
    exists (
      select 1 from public.attempts a
      where a.id = attempt_answers.attempt_id and a.user_id = auth.uid()
    )
  );
