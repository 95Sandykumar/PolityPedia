-- 0012_split_jobs.sql  (issue 12-pdf-split-worker)
--
-- P9, the PDF split worker. Issue 11 built the job row and the review screen;
-- this file gives the WORKER the two things it needs that no signed-in user
-- does:
--
--  1. `questions.job_id` -- which split produced this draft. design.md D4
--     (re-run safety): "P9 writes questions under the job id; rerun deletes
--     drafts of that job first." Without the column there is no way to tell a
--     draft the AI wrote from one the teacher typed, so a retry would either
--     double the rows or delete the teacher's own work.
--
--  2. `claim_ingest_job()` -- take ONE queued job in ONE statement. PostgREST
--     cannot express `for update skip locked`, so the claim lives here where
--     Postgres can make it atomic. design.md D1/D5: 1 job at a time.
--
-- WHO RUNS THE WORKER. Not a user. It holds the SERVICE-ROLE key, which
-- bypasses RLS, which is why `ingest_jobs.status` in 0011 is commented "the
-- worker (P9) moves it with the service role". Nothing in `web/src/app/`
-- imports the worker's store, so that key never reaches a route handler or a
-- browser.
--
-- WHAT THIS FILE DOES NOT CHANGE. Risk 1 stands exactly as 0011 left it: the
-- worker writes `status = 'draft'` and `checked = false`, and
-- `questions_live_is_checked_check` means no bug in the worker, and no answer
-- from the model, can produce a live question. The worker has no reason to
-- call `publish_paper()` and is not granted it.

-- --------------------------------------------------------------------------
-- questions.job_id
-- --------------------------------------------------------------------------
--
-- `on delete set null`, NOT cascade. A teacher may have reviewed, fixed and
-- published these questions long after the job row stopped being interesting;
-- deleting the job must never delete content a student can see. The column
-- going NULL just means "we no longer know which split made this", which is
-- true.
alter table public.questions
  add column if not exists job_id uuid references public.ingest_jobs (id) on delete set null;

comment on column public.questions.job_id is
  'The split job that produced this draft, or NULL for a question the teacher typed. A re-run deletes this job''s own DRAFTS before writing new ones (design.md D4). Issue 12-pdf-split-worker.';

-- The worker's only read of `questions`: "this job's drafts, so I can delete
-- them". Partial, because a hand-typed question has no job id and there is
-- nothing to look up for it.
create index if not exists questions_job_idx
  on public.questions (job_id)
  where job_id is not null;

-- --------------------------------------------------------------------------
-- claim_ingest_job() -- the atomic claim
-- --------------------------------------------------------------------------
--
-- Returns the one row it claimed, or no rows when the queue is empty.
--
-- `for update skip locked` is the whole point. Two workers (a Realtime push
-- and the 5-minute sweep firing at the same moment, or a second PM2 instance
-- somebody started by hand) each lock a DIFFERENT row instead of both
-- claiming the same job and writing the same questions twice. The subselect
-- takes the lock; the UPDATE moves the row out of `queued` in the same
-- statement, so there is no window in which the row is picked but still
-- claimable.
--
-- `attempts = 1` on claim, not `attempts + 1`: each RUN counts its own three
-- tries (design.md F4). A teacher who retries a failed job gets three fresh
-- tries, which is what pressing retry means; carrying the old count over
-- would make the second press do nothing.
--
-- `error = null` on claim, so the review screen stops showing last run's
-- reason the moment this run starts.
--
-- SECURITY INVOKER (the default). The worker's service role bypasses RLS and
-- sees the whole queue; a teacher calling it goes through
-- `ingest_jobs_update_own` and can therefore only ever claim their own job,
-- which they can already do with a plain UPDATE. There is no privilege here
-- that the caller did not already have, so there is no second permission model
-- to keep in step with the policies.
--
-- plpgsql, not sql, so `order by` and `limit` inside the subselect are plain
-- to read and the RETURNING row can be handed straight back.
create or replace function public.claim_ingest_job()
returns setof public.ingest_jobs
language plpgsql
volatile
as $$
begin
  return query
  update public.ingest_jobs j
  set status   = 'running',
      attempts = 1,
      error    = null
  where j.id = (
    select inner_j.id
    from public.ingest_jobs inner_j
    where inner_j.status = 'queued'
    -- Oldest first: the teacher who has been waiting longest goes next.
    order by inner_j.created_at, inner_j.id
    limit 1
    for update skip locked
  )
  returning j.*;
end;
$$;

comment on function public.claim_ingest_job() is
  'Take ONE queued split job, oldest first, and mark it running with attempts = 1, atomically (for update skip locked). Returns the claimed row, or no rows. SECURITY INVOKER, so RLS still decides what the caller can see. Issue 12-pdf-split-worker.';

-- The worker uses the service role, which bypasses RLS and does not need a
-- grant. `authenticated` is granted so a teacher's own retry path works
-- through the same one statement rather than a second hand-written UPDATE;
-- RLS keeps them inside their own rows. `service_role` is NOT named here: it
-- is platform config like `auth.users`, so naming it would break the PGlite
-- test harness, which has only `anon` and `authenticated` (web/CLAUDE.md).
grant execute on function public.claim_ingest_job() to authenticated;
