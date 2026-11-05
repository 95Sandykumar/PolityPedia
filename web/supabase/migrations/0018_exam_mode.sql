-- 0018_exam_mode.sql  (issue 18-exam-mode)
--
-- A student sits a mock test under a CLOCK: a timer runs, the answer key stays
-- on the server until they submit, and the score is then worked out in the
-- database with the exam's own marking scheme.
--
-- No new table. 0013 built `attempts.mode` and `attempts.deadline_at` for
-- exactly this, and 0017 wired the mock-test parent and the paywall. What is
-- MISSING is the three things that cannot live in a component, because a
-- component runs on the student's own phone:
--
--  1. "ANSWERED, NOT MARKED YET" HAS TO BE A LEGAL ROW. F-E5 says the answer
--     key never reaches the phone before submit, so in exam mode the browser
--     HAS no verdict to send. 0013's `attempt_answers_verdict_check` refused
--     that row in both directions. The half that mattered ("a verdict with no
--     chosen option is a bug upstream") stays; the other half has to go.
--
--  2. THE TIMER IS A DEADLINE IN THE DATABASE, NOT A COUNTDOWN IN JAVASCRIPT.
--     The clock on screen is a courtesy. A student who changes the device
--     clock, re-opens the tab an hour later, or whose offline queue flushes a
--     held answer after time is up must write NOTHING. Two RESTRICTIVE
--     policies make Postgres the one that says no.
--
--  3. THE SCORE IS WORKED OUT ON THE SERVER. `score_attempt()` reads
--     `questions.correct_idx` itself and marks with `exams.marks_correct` /
--     `exams.marks_wrong` (F-E6), so the number owes nothing to anything the
--     phone sent. It is also SAFE TO CALL TWICE, because a dropped reply on a
--     4G connection is normal and a retry must not re-mark a closed sitting.
--
-- WHAT IS NOT IN THIS FILE. No proctoring and no tab-switch detection (scope
-- guard). And the questions policies are untouched: `questions_mock_needs
-- _access` from 0016 still decides WHICH questions a student may read, and
-- `score_attempt()` is SECURITY DEFINER so a student never needs to read
-- `correct_idx` for their own score to be computed.

-- --------------------------------------------------------------------------
-- 1. An answer may be stored before anybody has marked it
-- --------------------------------------------------------------------------
--
-- Read the new constraint as an implication: a verdict => a chosen option.
-- So the three legal rows are
--
--   chosen_idx null, is_correct null  -- marked for later, not answered
--   chosen_idx set,  is_correct null  -- answered in exam mode, not marked yet
--   chosen_idx set,  is_correct set   -- answered and marked
--
-- and the one that is still refused is a verdict with nothing chosen, which is
-- the shape 0013 called "a bug upstream, not a state". `readAnswerUpsert` in
-- `src/lib/attempts/types.ts` is unchanged, so the PRACTICE route still
-- refuses a half answer before it ever reaches Postgres; the exam route has
-- its own reader (`readExamAnswer`) that never sends a verdict at all.
alter table public.attempt_answers
  drop constraint if exists attempt_answers_verdict_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'attempt_answers_verdict_check'
  ) then
    alter table public.attempt_answers
      add constraint attempt_answers_verdict_check
      check (is_correct is null or chosen_idx is not null);
  end if;
end
$$;

comment on column public.attempt_answers.is_correct is
  'The verdict. NULL until somebody marks it: in practice mode the player marks at once, in exam mode score_attempt() marks every answer at submit, because the phone was never given correct_idx (F-E5). Stored, so a teacher fixing a key later cannot move a score the student already saw.';

-- --------------------------------------------------------------------------
-- 2. The clock, enforced by Postgres
-- --------------------------------------------------------------------------
--
-- "Is this sitting still taking answers?" in ONE place, so the insert policy
-- and the update policy can never drift apart.
--
--  * `submitted_at is null` -- a closed sitting takes nothing more, in either
--    mode. The score the student has seen is final.
--  * `deadline_at is null or now() < deadline_at` -- practice has no deadline
--    (0017 makes that a CHECK), so practice is unaffected. An exam sitting
--    stops accepting answers the second its deadline passes.
--
-- SECURITY INVOKER (the default) on purpose: the read of `attempts` inside is
-- filtered by `attempts_select_own`, so somebody else's sitting is invisible,
-- comes back NULL, and `coalesce` turns that into FALSE. It fails CLOSED.
create or replace function public.attempt_is_open(for_attempt uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
    (
      select a.submitted_at is null
         and (a.deadline_at is null or now() < a.deadline_at)
      from public.attempts a
      where a.id = for_attempt
    ),
    false
  )
$$;

comment on function public.attempt_is_open(uuid) is
  'True while a sitting still takes answers: not submitted, and either no deadline (practice) or the deadline has not passed (exam). SECURITY INVOKER, so an attempt the caller cannot read fails closed. Issue 18-exam-mode.';

grant execute on function public.attempt_is_open(uuid) to authenticated;

-- RESTRICTIVE, so each is ANDed with the `attempt_answers_*_own` policies from
-- 0013 rather than ORed with them. What a signed-in student ends up allowed to
-- write is:
--
--   (an answer in a sitting they own)  AND  (that sitting is still open)
--
-- BOTH halves are needed for the player's upsert: `on conflict ... do update`
-- is checked against the INSERT policy and, for the row it ends up updating,
-- against the UPDATE policy as well. One without the other would let a held
-- answer land after time is up as long as the question had been touched once.
create policy attempt_answers_insert_open on public.attempt_answers
  as restrictive
  for insert to authenticated
  with check (public.attempt_is_open(attempt_answers.attempt_id));

create policy attempt_answers_update_open on public.attempt_answers
  as restrictive
  for update to authenticated
  using (public.attempt_is_open(attempt_answers.attempt_id))
  with check (public.attempt_is_open(attempt_answers.attempt_id));

comment on policy attempt_answers_insert_open on public.attempt_answers is
  'The exam clock on a new answer: refused once the sitting is submitted or its deadline has passed. RESTRICTIVE, so it narrows attempt_answers_insert_own from 0013. Practice has no deadline, so practice is untouched. Issue 18-exam-mode.';

comment on policy attempt_answers_update_open on public.attempt_answers is
  'The same clock on a CHANGE to an answer, which is the half the upsert in the player actually hits on a second tap. Issue 18-exam-mode.';

-- --------------------------------------------------------------------------
-- 3. The marking, on the server
-- --------------------------------------------------------------------------
--
-- SECURITY DEFINER, for two reasons that both come from F-E5:
--
--  a. The student must never need to read `correct_idx` for their own score to
--     exist. A definer function reads the key, writes the verdicts, and hands
--     back ONE NUMBER.
--  b. An auto-submit happens exactly when the deadline has passed, which is
--     precisely when the restrictive policies above refuse every write. The
--     owner of these tables is not subject to them, so the marking run still
--     goes through while a student's own writes do not.
--
-- Ownership is therefore checked HERE, by hand, because RLS is not doing it:
-- a sitting that is not `auth.uid()`'s is refused outright.
--
-- SAFE TO CALL TWICE. A closed sitting returns its STORED score and marks
-- nothing again, so a retry after a dropped reply gives the same number, and a
-- teacher fixing a wrong `correct_idx` next week cannot move a score a student
-- has already seen (the same rule 0013 stated for `is_correct`).
create or replace function public.score_attempt(attempt_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  caller      uuid := auth.uid();
  owner       uuid;
  submitted   timestamptz;
  stored      integer;
  exam        uuid;
  -- The FALLBACK marking: one mark a question, no negative marking. PGT and
  -- TGT have no published scheme (PRD section 6), and scoring an unknown
  -- scheme at zero would hand a student 0 out of 0 for a paper they got right.
  marks_right numeric := 1;
  marks_wrong numeric := 0;
  found_right numeric;
  found_wrong numeric;
  total       numeric;
  final       integer;
begin
  if caller is null then
    raise exception 'not signed in'
      using errcode = 'insufficient_privilege';
  end if;

  select a.user_id, a.submitted_at, a.score
    into owner, submitted, stored
  from public.attempts a
  where a.id = score_attempt.attempt_id;

  if owner is null then
    raise exception 'attempt not found'
      using errcode = 'no_data_found';
  end if;

  if owner <> caller then
    raise exception 'attempt belongs to another student'
      using errcode = 'insufficient_privilege';
  end if;

  -- Already closed: hand back the number the student has seen, and touch
  -- nothing. This is the whole of "safe to call twice".
  if submitted is not null then
    return stored;
  end if;

  -- The exam behind this sitting: through the mock set for a mock test, or
  -- straight off the paper for a past paper. Exactly one of the two is set
  -- (`attempts_one_parent_check`), so at most one branch returns a row.
  select coalesce(
    (
      select s.exam_id
      from public.attempts a
      join public.mock_tests t on t.id = a.test_id
      join public.mock_sets  s on s.id = t.set_id
      where a.id = score_attempt.attempt_id
    ),
    (
      select p.exam_id
      from public.attempts a
      join public.papers p on p.id = a.paper_id
      where a.id = score_attempt.attempt_id
    )
  ) into exam;

  -- The same three refusals as `markingOf()` in `src/lib/practice/types.ts`,
  -- so a score never depends on which side worked it out:
  --   marks_correct of zero or less  -> one mark  (a zero scheme scores nothing)
  --   marks_wrong above zero         -> no penalty (never PAY for a wrong answer)
  --   anything missing               -> the fallback
  if exam is not null then
    select e.marks_correct, e.marks_wrong
      into found_right, found_wrong
    from public.exams e
    where e.id = exam;

    if found_right is not null and found_right > 0 then
      marks_right := found_right;
    end if;
    if found_wrong is not null and found_wrong < 0 then
      marks_wrong := found_wrong;
    end if;
  end if;

  -- The marking run. `correct_idx` is read HERE and nowhere else, so the
  -- verdict owes nothing to the phone. An answer with no chosen option is left
  -- alone: "marked for later, not answered" is not a wrong answer.
  update public.attempt_answers aa
  set is_correct = (q.correct_idx = aa.chosen_idx)
  from public.questions q
  where q.id = aa.question_id
    and aa.attempt_id = score_attempt.attempt_id
    and aa.chosen_idx is not null;

  select coalesce(
    sum(
      case
        when aa.is_correct is true  then marks_right
        when aa.is_correct is false then marks_wrong
        else 0
      end
    ),
    0
  ) into total
  from public.attempt_answers aa
  where aa.attempt_id = score_attempt.attempt_id;

  -- `attempts.score` is an integer column, so a third-of-a-mark scheme is
  -- rounded to a whole mark, exactly as `scoreAnswers()` does in TypeScript.
  final := round(total)::integer;

  -- `submitted_at is null` makes the close WRITE-ONCE even under two requests
  -- that arrive together.
  update public.attempts
  set submitted_at = now(),
      score        = final
  where id = score_attempt.attempt_id
    and submitted_at is null;

  if not found then
    -- The other request got there first. Its score is the one the student has
    -- seen, so that is the one to return.
    select a.score into final
    from public.attempts a
    where a.id = score_attempt.attempt_id;
  end if;

  return final;
end;
$$;

comment on function public.score_attempt(uuid) is
  'Mark and close one sitting on the SERVER: reads questions.correct_idx itself, marks with the exam''s marks_correct / marks_wrong (F-E6), then sets submitted_at and score once. Returns the stored score unchanged when called again, so a retry cannot re-mark a closed sitting. SECURITY DEFINER, so a student never needs to read the answer key (F-E5) and an auto-submit still works after the deadline. Issue 18-exam-mode.';

grant execute on function public.score_attempt(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- 4. The timer read
-- --------------------------------------------------------------------------
--
-- "My open timed sitting of this test", which is what the load route resumes
-- so a student who closes the tab walks back into the SAME clock rather than a
-- fresh hour. 0017's `attempts_one_open_per_test_idx` already stops a second
-- one existing; this index is what makes finding the first one cheap.
create index if not exists attempts_open_exam_idx
  on public.attempts (user_id, test_id, deadline_at)
  where mode = 'exam' and submitted_at is null;
