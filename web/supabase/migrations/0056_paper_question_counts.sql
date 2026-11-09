-- 0056_paper_question_counts.sql  (issue 81-fix-papers-count-truncation)
--
-- One row per paper: how many LIVE questions it has.
--
-- THE BUG THIS FIXES. The papers list used to ask PostgREST for every live
-- question row of the listed papers and count them in JavaScript. PostgREST
-- caps a response (1000 rows on the default `max-rows`) and one paper holds up
-- to 200 questions (`questions_number_check`), so a teacher with about six
-- full papers had rows cut off the end. The papers after the cut read
-- "0 questions", and the list hid their Practice button although they have
-- questions. A student could not practise a paper that was ready.
--
-- The count is now made by Postgres with `group by paper_id`, so the response
-- holds one row per paper and is as short as the paper list itself. No cap can
-- reach it.
--
-- SAME ROW RULES AS BEFORE, which is the whole point of
-- `security_invoker = true`. The view reads `public.questions` with the
-- CALLER's rights, so `questions_select_live` (0011) still decides what is
-- counted: a student counts only LIVE questions of an APPROVED teacher, and a
-- teacher counts their own drafts too, exactly as the old JavaScript count
-- did. An owner-rights view (the pattern in 0005 and 0020) would be WRONG
-- here: it would count every teacher's rows for everybody and leak how big an
-- unapproved teacher's paper is.
--
-- `security_barrier` is not set, and is not needed: the view exposes no column
-- the caller could not already read, and there is no cheap-function trick to
-- defend against a `count(*)`.
--
-- NO ROW FOR A PAPER WITH NO LIVE QUESTION. `group by` cannot invent a group
-- that has no rows, and the reader (`src/lib/papers/progress.ts`) already
-- reads a missing paper as zero.

create or replace view public.paper_question_counts
with (security_invoker = true) as
select
  q.paper_id,
  count(*)::integer as question_count
from public.questions q
where q.status = 'live'
  and q.paper_id is not null
group by q.paper_id;

comment on view public.paper_question_counts is
  'Live questions per past paper, counted in Postgres so a long list is never truncated by the PostgREST row cap. security_invoker, so questions_select_live still decides which rows count. Issue 81-fix-papers-count-truncation.';

-- Supabase default privileges have already handed `all` on this view to the
-- API roles by now, so say READ-ONLY out loud. A grouped view is not
-- auto-updatable, so a write would fail anyway; this makes the claim a grant
-- instead of a side effect of the SQL shape.
revoke all on public.paper_question_counts from anon, authenticated;
grant select on public.paper_question_counts to anon, authenticated;

-- The count scans this paper's live rows, so give it an index that already
-- holds the answer. Partial, so draft rows and mock-test rows stay out of it.
create index if not exists questions_live_paper_idx
  on public.questions (paper_id)
  where status = 'live' and paper_id is not null;
