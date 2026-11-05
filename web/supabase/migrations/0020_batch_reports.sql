-- 0020_batch_reports.sql  (issue 20-batch-reports)
--
-- F-B4: "Teacher sees batch scores (per test and per student) on their own
-- tests only."  design.md V3: "Teacher sees batch scores."
--
-- 0013_attempts.sql set the terms this file has to meet:
--
--   "PRIVACY. An attempt is a student's score. NOBODY else reads it: not
--    another student, and not the teacher who owns the paper. Teacher
--    reporting over batches is a later issue and will go through an
--    owner-rights view, the way `teachers_public` does in 0005, never by
--    widening these policies."
--
-- So this file adds NO policy, changes NO policy and touches NO table. It adds
-- two OWNER-RIGHTS VIEWS, and nothing else:
--
--   * `batch_report_tests`  -- the COLUMNS of the report: which tests.
--   * `batch_report_scores` -- the CELLS: one score per student per test.
--
-- WHY A VIEW AND NOT A SECURITY DEFINER FUNCTION. Both would work, and both
-- would be as tight. A view wins on three counts. It is what 0013 promised, so
-- the privacy note there stays true word for word. It takes a filter instead
-- of an argument, so PostgREST reads it with `?batch_id=eq.<id>` like any
-- other table and there is no RPC shape for the client to special-case. And a
-- function with a `returns table` whose OUT names collide with the columns it
-- reads (`test_id`, `set_id`) is a well-known ambiguity trap; a view has no
-- parameters, so the trap does not exist.
--
-- WHY NO `security_invoker`. Without it a view runs with the OWNER's rights,
-- so the `attempts_select_own` policy does not apply inside it. That is the
-- whole point: a teacher must read a score they can never read as a row. DO
-- NOT add `with (security_invoker = true)` here; it would make both views
-- return nothing at all, and the report would go blank with no error.
--
-- WHAT STOPS IT LEAKING, then, is the `where b.teacher_id = auth.uid()` in
-- each view plus the join through `mock_sets.teacher_id = b.teacher_id`. Three
-- separate things have to be true before one score appears:
--
--   1. the caller owns the batch,
--   2. the student is a CURRENT member of that batch,
--   3. the test belongs to a mock set the SAME teacher owns.
--
-- Drop any one and the row disappears. Teacher A reading a batch-A member's
-- score on teacher B's test fails (3). Teacher B reading batch A fails (1). A
-- student reading either view fails (1), which is why there is no student
-- report here: a student already reads their own attempts directly.
--
-- `security_barrier` is on both, which stops the cheap trick where a
-- user-supplied function in the caller's WHERE clause runs before the view's
-- own filter and sees the rows it was meant to hide.
--
-- SCOPE (issue 20 notes): no export, no charts. Two views and a table.

-- ---------------------------------------------------------------------------
-- batch_report_tests: the columns
-- ---------------------------------------------------------------------------
--
-- A column is a test of one of the teacher's OWN sets, and the set is either
--
--   * given to this batch free (`batch_sets`, V3), which is the normal case
--     and the reason the column exists before anybody has sat the test, or
--   * a set a member has already sat a test of, which catches the student who
--     bought the set themselves or holds it from another batch. Without this
--     half, `batch_report_scores` could hold a cell with no column over it and
--     the screen would quietly drop a real score.
--
-- `distinct` because the two halves can both be true for the same test.
--
-- The OUT column is `test_position`, not `position`: `position` is a function
-- name in Postgres and reads badly in a JSON body besides.

create or replace view public.batch_report_tests with (security_barrier = true) as
select distinct
  b.id       as batch_id,
  t.id       as test_id,
  s.id       as set_id,
  s.title    as set_title,
  t.title    as test_title,
  t.position as test_position
from public.batches b
join public.mock_sets s
  on s.teacher_id = b.teacher_id
join public.mock_tests t
  on t.set_id = s.id
where b.teacher_id = auth.uid()
  and (
    exists (
      select 1
      from public.batch_sets bs
      where bs.batch_id = b.id
        and bs.set_id = s.id
    )
    or exists (
      select 1
      from public.attempts a
      join public.batch_members m
        on m.user_id = a.user_id
       and m.batch_id = b.id
      where a.test_id = t.id
        and a.submitted_at is not null
        and a.score is not null
    )
  );

comment on view public.batch_report_tests is
  'The COLUMNS of one batch score report: the teacher''s own tests this batch gets free, plus any of their own tests a member has already sat. Owner-rights view, filtered by teacher_id = auth.uid(). Read it as ?batch_id=eq.<id>. Issue 20-batch-reports.';

-- Supabase default privileges grant every new relation to anon and
-- authenticated, and a view runs as its owner, so the grant has to be narrowed
-- by hand. These views are multi-table joins and so are not auto-updatable,
-- but saying SELECT out loud costs nothing and survives a later rewrite that
-- would be.
revoke all on public.batch_report_tests from anon, authenticated;
grant select on public.batch_report_tests to authenticated;

-- ---------------------------------------------------------------------------
-- batch_report_scores: the cells
-- ---------------------------------------------------------------------------
--
-- One row per (batch, student, test). The student is a CURRENT member, so a
-- student the teacher removed (V2) leaves the report with them, and the test
-- belongs to a set the same teacher owns.
--
-- WHY THE NEWEST SITTING AND NOT THE BEST. A student may sit the same test
-- twice, so one of them has to win. `distinct on (... order by submitted_at
-- desc)` picks the latest. A report that quietly showed the best score would
-- hide a student whose marks have dropped, which is the one thing this screen
-- exists to show. The teacher wants where the student is now.
--
-- WHY `score is not null` AS WELL AS `submitted_at is not null`. 0013 allows a
-- submitted attempt whose score has not been written yet. That is a sitting,
-- not a score, and a NULL in a score column reads as a zero to anybody
-- skimming the table.
--
-- `submitted_at` comes along so the screen can say when, and so two teachers
-- looking at the same cell are looking at the same sitting.

create or replace view public.batch_report_scores with (security_barrier = true) as
select distinct on (b.id, m.user_id, a.test_id)
  b.id           as batch_id,
  m.user_id      as user_id,
  a.test_id      as test_id,
  a.score        as score,
  a.submitted_at as submitted_at
from public.batches b
join public.batch_members m
  on m.batch_id = b.id
join public.attempts a
  on a.user_id = m.user_id
join public.mock_tests t
  on t.id = a.test_id
join public.mock_sets s
  on s.id = t.set_id
 and s.teacher_id = b.teacher_id
where b.teacher_id = auth.uid()
  and a.submitted_at is not null
  and a.score is not null
order by b.id, m.user_id, a.test_id, a.submitted_at desc;

comment on view public.batch_report_scores is
  'The CELLS of one batch score report: the newest submitted, scored sitting per current batch member per test, on the batch owner''s OWN tests only (F-B4). Owner-rights view, filtered by teacher_id = auth.uid(), so a teacher reads a score they can never read as an attempts row. Issue 20-batch-reports.';

revoke all on public.batch_report_scores from anon, authenticated;
grant select on public.batch_report_scores to authenticated;

-- ---------------------------------------------------------------------------
-- The one index this report needs
-- ---------------------------------------------------------------------------
--
-- Both views walk `attempts` by `user_id` and `test_id`. 0013's
-- `attempts_user_test_idx` is `(user_id, test_id, started_at desc)` and is
-- partial on `test_id is not null`, which is exactly the shape of the join
-- here, so there is nothing to add. The batch side is covered by
-- `batch_members`'s own primary key and `batch_sets`'s. No new index.
