-- 0017_practice_mode.sql  (issue 17-practice-mode)
--
-- A student sits a MOCK TEST in practice mode: full paper or one topic, no
-- timer, right or wrong after every question, a score at the end, and a tick
-- on the mock list afterwards.
--
-- No new table. `attempts` and `attempt_answers` were built in 0013 for past
-- papers, and the `mode`, `topic_id` and `test_id` columns were already there
-- so the shared player could grow into mock tests without a migration. What
-- was MISSING is everything 0013 could not write yet, because `mock_tests`
-- (0015) and `set_access` (0016) did not exist when it ran:
--
--  1. `attempts.test_id` had NO FOREIGN KEY. A sitting could hang on an id
--     that is not a test, and deleting a test would leave its sittings behind.
--  2. A PRACTICE sitting could carry a `deadline_at`. Practice means no timer
--     (F-E4), so a deadline there would draw a clock the student was never
--     promised. 0013's header says NULL; this makes Postgres say it.
--  3. A student could START a sitting of a LOCKED test. The QUESTIONS were
--     already refused by `questions_mock_needs_access` in 0016, so the sitting
--     would have been empty, but an empty row is still a row: a locked test
--     must not be able to leave a trail of attempts behind, and "Attempt"
--     must fail loudly rather than open a player with nothing in it.
--  4. Two open sittings of the same test, same mode and same topic could
--     exist side by side. The client resumes the newest one first, so the
--     older one would quietly keep the answers a student thought they gave.
--
-- WHERE THE PAYWALL LIVES. Still in ONE place: `has_test_access()` from 0016.
-- This file calls it, it does not re-state the rule. A change to how a set is
-- unlocked (a purchase in issue 26, a batch grant in issue 19) lands in that
-- function and both gates move together.
--
-- NOT HERE: the timer (issue 18-exam-mode). `mode = 'exam'` and `deadline_at`
-- stay exactly as 0013 left them, so issue 18 adds a timer and not a column.

-- --------------------------------------------------------------------------
-- 1. A sitting hangs on a real test
-- --------------------------------------------------------------------------
--
-- `on delete cascade` matches `paper_id` in 0013: a test that is gone has no
-- sittings, and a score for a test nobody can open is a row the student can
-- never see again anyway.
--
-- Guarded, because a constraint has no `if not exists` and this file must be
-- safe to re-run (the test harness applies every migration on every boot).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'attempts_test_fkey'
  ) then
    alter table public.attempts
      add constraint attempts_test_fkey
      foreign key (test_id) references public.mock_tests (id) on delete cascade;
  end if;
end
$$;

comment on column public.attempts.test_id is
  'Mock test this sitting belongs to. The FK to mock_tests arrived with issue 17-practice-mode, once 0015 had created the table.';

-- --------------------------------------------------------------------------
-- 2. Practice has no timer
-- --------------------------------------------------------------------------
--
-- Read as an implication: practice => no deadline. Exam mode (issue 18) is
-- left completely alone, so it can still carry one.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'attempts_practice_no_deadline_check'
  ) then
    alter table public.attempts
      add constraint attempts_practice_no_deadline_check
      check (mode <> 'practice' or deadline_at is null);
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 3. A locked test cannot be started
-- --------------------------------------------------------------------------
--
-- RESTRICTIVE, so it is ANDed with `attempts_insert_own` from 0013 rather
-- than ORed with it. What a signed-in student ends up allowed to insert is:
--
--   (their own row)  AND  (a past paper, or a test that is open to them)
--
-- `test_id is null` lets every past-paper sitting through untouched: V8 says
-- past papers are FREE, and there is no set to unlock.
--
-- INSERT ONLY, on purpose. The UPDATE path is how a sitting is SUBMITTED, and
-- an admin grant that expires in the middle of a paper must not be able to
-- throw away the score a student has just earned. Starting is the gate; the
-- questions themselves are gated for the whole sitting by 0016.
create policy attempts_mock_needs_access on public.attempts
  as restrictive
  for insert to authenticated
  with check (
    attempts.test_id is null
    or public.has_test_access(attempts.test_id)
  );

comment on policy attempts_mock_needs_access on public.attempts is
  'The mock paywall on the start of a sitting: a mock attempt needs a valid set_access row or a free-sample test. RESTRICTIVE, so it narrows attempts_insert_own from 0013 instead of widening it, and it calls has_test_access() from 0016 rather than re-stating the rule. Issue 17-practice-mode.';

-- --------------------------------------------------------------------------
-- 4. One open sitting per test, mode and topic
-- --------------------------------------------------------------------------
--
-- The client resumes the newest open sitting before inserting one, so without
-- this index a double tap on Attempt (or a double render) could leave two,
-- and the answers a student gave into the older one would vanish from view.
--
-- `coalesce(topic_id, ...)` because NULL is not equal to NULL in a unique
-- index, so "the full paper" would otherwise never clash with itself. The
-- all-zero uuid stands for "no topic" and cannot be a real topic id.
--
-- The TOPIC is part of the key on purpose: a sitting of one topic holds
-- different questions from a sitting of the full paper, so they are two
-- different sittings and both may be open at once.
create unique index if not exists attempts_one_open_per_test_idx
  on public.attempts (
    user_id,
    test_id,
    mode,
    coalesce(topic_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where test_id is not null and submitted_at is null;

-- --------------------------------------------------------------------------
-- 5. The tick on the mock list
-- --------------------------------------------------------------------------
--
-- "The latest SUBMITTED sitting of this test, by me" is the read behind the
-- tick and the score (`listScores`). 0013's `attempts_user_test_idx` orders by
-- `started_at`, which is the Resume read; this one orders by `submitted_at`
-- and covers only finished sittings, which is a much smaller index.
create index if not exists attempts_user_test_submitted_idx
  on public.attempts (user_id, test_id, submitted_at desc)
  where test_id is not null and submitted_at is not null;
