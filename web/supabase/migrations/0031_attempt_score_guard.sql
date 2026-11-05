-- 0031_attempt_score_guard.sql  (issue 31-attempt-score-guard)
--
-- SECURITY FIX from the 2026-11-05 review: a student could write their own
-- score, their own deadline and their own verdict.
--
-- WHAT WAS OPEN. `attempts_update_own` in `0013_attempts.sql` asks one
-- question: "is this your row?". An RLS `with check` cannot see the OLD row,
-- so it cannot tell a submit from a forgery, and there was no trigger behind
-- it. One REST call was therefore enough to
--
--   PATCH /rest/v1/attempts?id=eq.X {"score":999,"submitted_at":"now()"}
--
-- which the batch report (issue 20) then showed a teacher as a real mark. The
-- same hole let a student set `submitted_at` back to null and re-open a closed
-- exam, move `deadline_at` to the year 2100 and sit a timed paper for ever, or
-- claim `is_correct` on an answer that was wrong.
--
-- THE RULE AFTER THIS FILE: THE SERVER OWNS THE NUMBERS.
--
--   * `attempts.score` and `attempts.submitted_at` are written by
--     `score_attempt()` (0018) and by nothing else. A student may neither
--     choose them on the way in nor change them afterwards.
--   * `attempts.deadline_at` is worked out HERE, from
--     `mock_tests.duration_min`. Whatever the caller sent is replaced.
--   * `attempts.user_id`, `paper_id`, `test_id` and `mode` are fixed once the
--     sitting exists: moving any of them would carry a score to another
--     student, another paper or out of its own clock.
--   * `attempt_answers.is_correct` is recomputed from `questions.correct_idx`
--     in practice mode, and REFUSED outright in exam mode, where the phone was
--     never given the key (F-E5).
--
-- WHY TRIGGERS AND NOT COLUMN PRIVILEGES. A `revoke update (score)` would
-- break the one legitimate writer too, because `score_attempt()` is owned by
-- the same role chain, and it would say nothing about an INSERT that carries a
-- score. A trigger can tell the two apart, and it is the pattern this schema
-- already uses (`profiles_block_role_change` and `teachers_block_admin_fields`
-- in `0002` and `0005`).
--
-- SECURITY INVOKER (the default) on both functions, and that is the whole
-- design: the check rests on `current_user`, which is `authenticated` for an
-- API caller and the FUNCTION OWNER inside a SECURITY DEFINER function. So
-- `score_attempt()` walks straight through, a webhook on the service role
-- walks through, and a migration walks through, while a signed-in student
-- does not. A student cannot become another database role, so this is not a
-- way in.
--
-- NOT IN THIS FILE: the answer key (ticket 30) and payments (scope guard).

-- --------------------------------------------------------------------------
-- 1. attempts: the score, the close and the clock
-- --------------------------------------------------------------------------
--
-- INSERT and UPDATE in one function, because the two halves state one rule
-- ("the server owns these columns") and splitting them is how they drift.
create or replace function public.attempts_server_owns_score()
returns trigger
language plpgsql
set search_path = public, auth, pg_temp
as $$
declare
  minutes integer;
begin
  -- A platform path: a SECURITY DEFINER function (`score_attempt()`), the
  -- service role, or a migration. Those own these columns, so they pass.
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A sitting is born OPEN and UNMARKED. Both numbers arrive later, from
    -- `score_attempt()`, or they are not a score at all.
    if new.score is not null then
      raise exception 'attempts.score is written by score_attempt(), not by the caller'
        using errcode = '42501';
    end if;
    if new.submitted_at is not null then
      raise exception 'attempts.submitted_at is written by score_attempt(), not by the caller'
        using errcode = '42501';
    end if;

    -- The clock starts NOW, whatever the body said. A `started_at` in the
    -- future would otherwise buy a longer sitting through the deadline check.
    new.started_at := now();

    -- THE DEADLINE IS THE SERVER'S. `mock_tests.duration_min` is the agreed
    -- length of the test (0015 constrains it to 1 minute .. 6 hours), so the
    -- deadline is that many minutes from now and nothing else.
    --
    -- A sitting with NO MOCK TEST keeps no clock, which is exactly what the
    -- app does today: `AttemptsClient.openOrStartForPaper` has never sent a
    -- deadline, and a past paper has no duration to read.
    --
    -- PRACTICE IS LEFT ALONE on purpose, so a practice sitting that arrives
    -- with a deadline is still REFUSED by `attempts_practice_no_deadline_check`
    -- (0017) rather than quietly cleaned up: a timer in practice mode is a bug
    -- in the caller, and it should hear about it.
    if new.mode = 'exam' then
      if new.test_id is null then
        new.deadline_at := null;
      else
        -- A plain read, so RLS applies. `mock_tests_select_parent` (0015) lets
        -- any signed-in student read a test whose set exists, which is every
        -- test they could be starting. The fallback is `duration_min`'s own
        -- default, so an unreadable row gives an hour and never NO clock.
        select t.duration_min into minutes
        from public.mock_tests t
        where t.id = new.test_id;

        new.deadline_at := now() + (coalesce(minutes, 60) * interval '1 minute');
      end if;
    end if;

    return new;
  end if;

  -- UPDATE. There is no legitimate caller-side write to any of these: the
  -- close goes through `score_attempt()`, and the other four are the identity
  -- of the sitting. `topic_id` and `started_at` are left writable, because the
  -- player owns the topic and neither can move a mark.
  if new.score        is distinct from old.score
  or new.submitted_at is distinct from old.submitted_at
  or new.deadline_at  is distinct from old.deadline_at
  or new.mode         is distinct from old.mode
  or new.test_id      is distinct from old.test_id
  or new.paper_id     is distinct from old.paper_id
  or new.user_id      is distinct from old.user_id then
    raise exception 'attempts.score, submitted_at, deadline_at, mode, test_id, paper_id and user_id belong to the server'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.attempts_server_owns_score() is
  'Security fix: blocks a student from writing their own score, close, deadline, mode, parent or owner on attempts, and makes the exam deadline mock_tests.duration_min from now. SECURITY INVOKER, so score_attempt() and the service role still write them. Issue 31-attempt-score-guard.';

drop trigger if exists attempts_server_owns_score on public.attempts;

create trigger attempts_server_owns_score
  before insert or update on public.attempts
  for each row
  execute function public.attempts_server_owns_score();

-- --------------------------------------------------------------------------
-- 2. attempt_answers: the verdict
-- --------------------------------------------------------------------------
--
-- PRACTICE AND EXAM ARE DIFFERENT, because F-E4 and F-E5 are different:
--
--  * PRACTICE shows right or wrong after every question, so the phone already
--    has `correct_idx` and sending a verdict is normal. It is RECOMPUTED here
--    instead of trusted, so a forged `is_correct` is corrected rather than
--    stored, and the player keeps working untouched. Recomputing (rather than
--    refusing a mismatch) also keeps A1: the retry queue can send the same
--    answer twice, and the second send cannot fail because a teacher fixed the
--    key in between.
--  * EXAM must have NO verdict on the device at all, so one arriving in a
--    write is REFUSED. `score_attempt()` marks every answer at submit, as the
--    owner, which is why it is not caught by this.
--
-- The verdict is read through RLS, like everything else a student does. A
-- question they cannot read gives NULL, which the 0018 check allows ("answered,
-- nobody has marked it yet") and `score_attempt()` repairs at submit, so this
-- fails CLOSED and never invents a mark.
create or replace function public.attempt_answers_server_owns_verdict()
returns trigger
language plpgsql
set search_path = public, auth, pg_temp
as $$
declare
  sitting_mode text;
  verdict      boolean;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  select a.mode into sitting_mode
  from public.attempts a
  where a.id = new.attempt_id;

  -- Anything that is not plainly a practice sitting is treated as exam: an
  -- attempt the caller cannot read is somebody else's, and the insert policy
  -- is about to refuse it anyway.
  if sitting_mode is distinct from 'practice' then
    if tg_op = 'INSERT' then
      if new.is_correct is not null then
        raise exception 'attempt_answers.is_correct is written by score_attempt(), not by the caller'
          using errcode = '42501';
      end if;
    elsif new.is_correct is distinct from old.is_correct then
      raise exception 'attempt_answers.is_correct is written by score_attempt(), not by the caller'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- `correct_idx = null` is NULL, so "marked for later, not answered" keeps
  -- the no-verdict state 0013 describes without a branch of its own.
  select (q.correct_idx = new.chosen_idx) into verdict
  from public.questions q
  where q.id = new.question_id;

  new.is_correct := verdict;
  return new;
end;
$$;

comment on function public.attempt_answers_server_owns_verdict() is
  'Security fix: recomputes attempt_answers.is_correct from questions.correct_idx for a practice answer and refuses one on an exam answer, so a student cannot mark their own paper. SECURITY INVOKER, so score_attempt() still marks at submit. Issue 31-attempt-score-guard.';

drop trigger if exists attempt_answers_server_owns_verdict on public.attempt_answers;

create trigger attempt_answers_server_owns_verdict
  before insert or update on public.attempt_answers
  for each row
  execute function public.attempt_answers_server_owns_verdict();

comment on column public.attempts.score is
  'Marks after negative marking, not the number of right answers. NULL until submitted. Written ONLY by score_attempt(): attempts_server_owns_score blocks every caller-side write (issue 31-attempt-score-guard).';

comment on column public.attempts.deadline_at is
  'Exam mode only: when the timer runs out. NULL in practice mode. Set by the SERVER from mock_tests.duration_min when the sitting starts, and immovable afterwards (issue 31-attempt-score-guard).';
