-- 0050_teacher_free_sample.sql  (issue 67a-teachers-reader-filter)
--
-- One row per APPROVED teacher for the Teachers list: the public teacher
-- columns, plus "does this teacher have a free sample test?", plus "which
-- exams do they teach?".
--
-- WHY A VIEW. The list needs two facts that live in other tables, and the
-- budget is ONE query for the whole list, never one per teacher (B8). Without
-- this view the page would either ask per teacher (N+1) or pull every live set
-- and every test row and fold them in JavaScript, which is the bug 0056 had to
-- fix on the papers list: PostgREST caps a response at 1000 rows and the
-- rows past the cap silently read as "no free sample".
--
-- ROLLBACK (manual; nothing is dropped from any table, so no data is lost):
--   drop view if exists public.teacher_cards;
--
-- OWNER'S RIGHTS, ON PURPOSE (no `security_invoker`), unlike 0056.
-- A badge is a PUBLIC claim about a teacher, so every reader must get the
-- same answer. With the caller's rights the answer would move around:
--   * a teacher reading the list may select their OWN draft sets
--     (`mock_sets_select_live` has `auth.uid() = teacher_id`), so their own
--     draft set would light the badge for them and nobody else;
--   * a student who BOUGHT an archived set may still select it
--     (`keeps_set()`), so an archived set would light the badge for that one
--     buyer.
-- The two WHERE lines below are therefore the whole rule, and they are
-- stricter than RLS, not weaker:
--   live, not archived set  +  free sample test, not archived.
--
-- WHAT THIS VIEW CAN LEAK, checked column by column:
--   * the seven teacher columns are `teachers_public` unchanged. That view is
--     already granted to `anon` and has no `real_name` column at all, so the
--     v0 privacy rule (PRD F-A5) is inherited, not re-implemented.
--   * `has_free_sample` is true only for a LIVE, non-archived set of an
--     APPROVED teacher. A draft set is never visible through it, not even as
--     a boolean. That is the "never expose draft sets" half of the rule.
--   * `exam_ids` is what `teacher_exams_select_public` (0007) already shows
--     every signed-in user for an approved teacher.
-- Nothing here is new information for a signed-in student, which is why the
-- grant below is `authenticated` ONLY. `anon` is left out: the logged-out
-- landing reads `teachers_public` (0005), it has no exam choice to filter by,
-- and `teacher_exams` is not granted to `anon` today.
--
-- `security_barrier = true`, as on `teachers_public`: a filter the caller
-- sends (`exam_ids=ov....`) must not be pushed below the view's own WHERE by
-- a cheap leaky function.
--
-- `exam_ids` is text[], NOT uuid[], deliberately. PostgREST sends an array
-- filter as a `{a,b}` literal; against a uuid[] column that literal has to be
-- coerced, and against text[] it never does. The ids are validated as uuids
-- by the reader before they reach the URL, so nothing is lost by comparing
-- them as text.

create or replace view public.teacher_cards with (security_barrier = true) as
select
  tp.user_id,
  tp.identity_mode,
  tp.display_name,
  tp.avatar_path,
  tp.bio_en,
  tp.bio_hi,
  tp.videos_visible,

  -- V11: "Test 1 can be a free sample". `exists` stops at the first hit, so
  -- this is a lookup, not a count, however many sets the teacher has.
  exists (
    select 1
    from public.mock_sets s
    join public.mock_tests mt on mt.set_id = s.id
    where s.teacher_id = tp.user_id
      and s.status = 'live'
      and s.archived_at is null
      and mt.is_free_sample
      and mt.archived_at is null
  ) as has_free_sample,

  -- `{}` and not NULL for a teacher who has listed no exam: an overlap test
  -- against NULL is NULL, which would drop the row out of BOTH the filtered
  -- list and the "show all" list without saying why.
  coalesce(
    (
      select array_agg(te.exam_id::text order by te.exam_id::text)
      from public.teacher_exams te
      where te.teacher_id = tp.user_id
    ),
    '{}'::text[]
  ) as exam_ids

from public.teachers_public tp;

comment on view public.teacher_cards is
  'One row per approved teacher for the Teachers list: the teachers_public columns, has_free_sample (a LIVE non-archived set with a non-archived free sample test), and exam_ids (text[], for an overlap filter against the student''s chosen exams). Owner rights on purpose, so the badge is the same for every reader. Issue 67a-teachers-reader-filter.';

-- Supabase default privileges have already handed `all` on this view to the
-- API roles by now, so the read-only claim has to be spelled out. A view with
-- a subquery in its select list is not auto-updatable and a write would fail
-- anyway; this makes it a grant instead of a side effect of the SQL shape.
revoke all on public.teacher_cards from anon, authenticated;
grant select on public.teacher_cards to authenticated;

-- The free-sample lookup asks mock_sets for "this teacher, live". The
-- existing `mock_sets_teacher_status_created_idx` (0015) is (teacher_id,
-- status, created_at desc) and already answers that, and the tests of one set
-- are reached by `mock_tests_set_position_idx`, so this migration adds NO
-- index. A free sample is always position 1 (`mock_tests_free_sample_check`),
-- which is the first entry that index hands back.
