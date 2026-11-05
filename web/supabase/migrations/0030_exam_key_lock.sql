-- 0030_exam_key_lock.sql  (issue 30-exam-key-lock)
--
-- F-E5, THE SECOND TIME. Issue 18 promised that the answer key never reaches
-- the phone during a timed sitting, and then kept the promise in TypeScript:
-- `examQuestions()` stripped `correct_idx` out of the payload and no prop ever
-- carried it. The DATABASE still handed the column over, so the promise was a
-- convention, not a rule, and a student could collect the key themselves:
--
--   GET {SUPABASE_URL}/rest/v1/questions?test_id=eq.<id>&select=number,correct_idx
--
-- with the published anon key and their own session token, in the middle of
-- the exam. There was a second door too: open the SAME test in PRACTICE mode
-- in another tab. Practice ships the key by design (D3 shows the result after
-- every tap), and `attempts_one_open_per_test_idx` in 0017 has `mode` in the
-- key, so an exam sitting and a practice sitting of one test can coexist.
--
-- Both doors close here, in Postgres, because every door that closes in a
-- route handler can be walked around by calling PostgREST directly.
--
-- FOUR THINGS IN THIS FILE:
--
--  1. `has_open_exam(uuid)` -- "is this caller mid-exam on this test?" One
--     function, so the key gate and the practice gate cannot drift apart.
--  2. THE COLUMN PRIVILEGE. `select` on `questions.correct_idx` is taken away
--     from `anon` and `authenticated` outright. Not a policy: a policy hides
--     ROWS, and the exam player needs the rows. This refuses one COLUMN, to
--     everybody, before RLS is even consulted. The REST request above now
--     answers 403 for every caller in every state of the world.
--  3. `question_keys(uuid[])` -- the ONE way in. SECURITY DEFINER, so it may
--     read the column it hands out; it checks `auth.uid()`, the set paywall
--     through `has_test_access()` (0016), the live/approved rule from 0011,
--     and it RAISES while the caller has an open exam sitting for that test.
--  4. A RESTRICTIVE insert policy on `attempts`, so the second tab has
--     nowhere to write and the practice player never opens.
--
-- WHAT DOES NOT CHANGE.
--
--  * `score_attempt()` (0018) reads `correct_idx` itself. It is SECURITY
--    DEFINER and runs as the table's owner, so a column privilege taken from
--    `authenticated` is not its gate. The marking still happens on the server
--    and still works after the deadline.
--  * A teacher still EDITS the key: `update` is a different privilege from
--    `select`, and `questions_update_own` from 0011 still decides whose row.
--    A teacher READS the key through `question_keys()` like everybody else,
--    which is the point: one way in means one rule to audit.
--  * The practice player and the AI explainer are untouched outside an exam.
--
-- NOT HERE: the AI explanation function is issue 32, and nothing about
-- payments is in scope.

-- ---------------------------------------------------------------------------
-- 1. "Is this caller sitting this test right now?"
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER, unlike `attempt_is_open()` in 0018, and on purpose: this
-- one is called from inside a WITH CHECK on `attempts` and from a definer
-- function, so it must not depend on the caller's own `attempts_select_own`
-- policy being evaluable at that moment. It returns a BOOLEAN about a test id
-- the caller already holds, so there is no row to leak.
--
-- OPEN MEANS NOT SUBMITTED. A sitting whose deadline has passed but which has
-- never been submitted is still open here, which is stricter than
-- `attempt_is_open()`: that function answers "may this still take answers?",
-- this one answers "is the score still unseen?". An unsubmitted paper is
-- about to be marked by `score_attempt()`, and handing the key over in that
-- window would hand it over for a sitting that still counts.
--
-- THE TOPIC IS IGNORED. A topic-only exam sitting still locks the whole
-- test's key, because the questions of one topic are questions of the test.
create or replace function public.has_open_exam(for_test uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.attempts a
    where a.user_id = auth.uid()
      and a.test_id = for_test
      and a.mode = 'exam'
      and a.submitted_at is null
  )
$$;

comment on function public.has_open_exam(uuid) is
  'True while the signed-in user has an exam sitting of this test that has not been submitted, deadline passed or not. The one definition of "mid-exam", used by question_keys() and by attempts_no_practice_during_exam. SECURITY DEFINER, so it does not depend on the caller''s own attempts policies. Issue 30-exam-key-lock.';

grant execute on function public.has_open_exam(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The column privilege: nobody reads `correct_idx` off the table
-- ---------------------------------------------------------------------------
--
-- Supabase's default privileges grant the API roles everything on every table
-- in `public`, and a TABLE-level `select` covers every column, including ones
-- added later. A column cannot be carved out of a table-level grant, so the
-- table-level `select` goes first and the columns we DO want come back one by
-- one.
--
-- The list is read out of the catalogue rather than typed, for two reasons: a
-- typo would silently hide a column the player needs, and a column added by a
-- later migration is granted automatically, which is the behaviour this
-- replaces. `correct_idx` is the ONE exclusion, and it is named once.
--
-- `insert`, `update` and `delete` are untouched, so a teacher still writes the
-- key. `questions_update_own` from 0011 is still what decides whose row.
do $$
declare
  readable text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into readable
  from pg_attribute a
  where a.attrelid = 'public.questions'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and a.attname <> 'correct_idx';

  if readable is null then
    raise exception 'public.questions has no readable columns left';
  end if;

  revoke select on public.questions from anon, authenticated;
  execute format(
    'grant select (%s) on public.questions to anon, authenticated',
    readable
  );
end
$$;

comment on column public.questions.correct_idx is
  '0 to 3, an index into `options`. NOT READABLE off this table by anon or authenticated (issue 30-exam-key-lock): the column privilege was revoked, so the one way a client gets the key is question_keys(), which refuses it while an exam sitting is open (F-E5). score_attempt() reads it directly because it is SECURITY DEFINER and owns the table.';

-- ---------------------------------------------------------------------------
-- 3. question_keys(): the one way in
-- ---------------------------------------------------------------------------
--
-- Takes the question ids the caller has ALREADY read (the rows are public to
-- them; only the key is not) and returns the keys they are allowed. One
-- function for all three readers, so there is one rule to audit:
--
--   * the practice player, after it has the paper (issue 17)
--   * the exam review, once the sitting is submitted (issue 18)
--   * the teacher's review and set-authoring screens (issues 11, 15, 24)
--
-- SECURITY DEFINER with a pinned `search_path`, so a caller cannot shadow
-- `public.attempts` or `public.teachers_public` with a temp table and talk the
-- function into reading the wrong one.
--
-- STABLE, not volatile: it writes nothing, and PostgREST will happily POST to
-- it either way.
--
-- IT RAISES rather than returning fewer rows when the exam gate is the one
-- refusing. Everywhere else in this schema an unreadable row simply is not
-- there, and that is right for "you have not bought this set". It is wrong
-- here: a silent empty answer mid-exam is indistinguishable from "this test
-- has no questions", and the app has to tell the student WHY practice is shut.
-- One loud 403 (PostgREST's mapping of `insufficient_privilege`) is a message
-- the route can turn into a sentence in two languages.
--
-- A TEACHER IS NEVER LOCKED OUT of their own question, even while sitting
-- their own test to try it: they wrote the key, so there is nothing to
-- protect them from.
create or replace function public.question_keys(question_ids uuid[])
returns table (question_id uuid, correct_idx integer)
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  caller uuid := auth.uid();
  locked uuid;
begin
  if caller is null then
    raise exception 'not signed in'
      using errcode = 'insufficient_privilege';
  end if;

  -- An empty or absent list is not an error, it is an empty answer: a test
  -- with no questions reads this way and must not look like a refusal.
  if question_ids is null or array_length(question_ids, 1) is null then
    return;
  end if;

  -- F-E5. ONE locked test is enough to refuse the whole call. The reader asks
  -- for one paper's worth of ids at a time, so a mixed list is a caller doing
  -- something odd, and the safe answer to odd is no.
  select q.test_id into locked
  from public.questions q
  where q.id = any(question_ids)
    and q.test_id is not null
    and q.teacher_id <> caller
    and public.has_open_exam(q.test_id)
  limit 1;

  if locked is not null then
    raise exception 'the answer key is locked while an exam sitting is open'
      using errcode = 'insufficient_privilege';
  end if;

  -- The same three rules the SELECT policies state, spelled out here because a
  -- definer function is not subject to them:
  --
  --   `questions_select_live`      (0011) -- own row, or live + approved
  --   `questions_mock_needs_access`(0016) -- a mock question needs the set
  --
  -- Anything else is simply not in the answer, which is how every other read
  -- in this schema behaves.
  return query
  select q.id, q.correct_idx
  from public.questions q
  where q.id = any(question_ids)
    and (
      q.teacher_id = caller
      or (
        q.status = 'live'
        and exists (
          select 1
          from public.teachers_public tp
          where tp.user_id = q.teacher_id
        )
        and (q.test_id is null or public.has_test_access(q.test_id))
      )
    );
end;
$$;

comment on function public.question_keys(uuid[]) is
  'The answer key for questions the caller has already read, and the ONLY way a client gets it (the column privilege on questions.correct_idx was revoked). Returns the caller''s own questions as a teacher, or live questions of an approved teacher whose set they hold (has_test_access), and RAISES insufficient_privilege while they have an open exam sitting for that test (F-E5). Issue 30-exam-key-lock.';

revoke all on function public.question_keys(uuid[]) from public, anon;
grant execute on function public.question_keys(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The second tab: no practice sitting while the exam is open
-- ---------------------------------------------------------------------------
--
-- RESTRICTIVE, so it is ANDed with `attempts_insert_own` (0013) and
-- `attempts_mock_needs_access` (0017) rather than ORed with them. What a
-- signed-in student may insert is now:
--
--   (their own row) AND (a past paper, or a set they hold)
--                   AND (not a practice sitting of a test they are sitting)
--
-- `test_id is null` leaves every past-paper sitting alone: a past paper has no
-- exam mode and no key to protect.
--
-- INSERT ONLY. A practice sitting that was already open when the exam started
-- must not become unwritable in the middle, or a student's stored answers
-- would start failing to save. It cannot be PLAYED either way, because the
-- player needs `question_keys()` and that refuses while the exam runs.
--
-- WHY THE NEW ROW CANNOT TRIGGER ITSELF: `has_open_exam()` only counts rows
-- whose `mode` is `exam`, and the row being checked here is a practice one.
create policy attempts_no_practice_during_exam on public.attempts
  as restrictive
  for insert to authenticated
  with check (
    attempts.mode <> 'practice'
    or attempts.test_id is null
    or not public.has_open_exam(attempts.test_id)
  );

comment on policy attempts_no_practice_during_exam on public.attempts is
  'Scenario B of the 2026-11-05 review: practice mode ships the answer key by design, so a practice sitting of a test whose exam sitting is still open is refused. RESTRICTIVE, so it narrows attempts_insert_own instead of widening it. Issue 30-exam-key-lock.';

-- ---------------------------------------------------------------------------
-- "This user's open exam sittings", for the gate above.
-- ---------------------------------------------------------------------------
--
-- 0018's `attempts_open_exam_idx` covers (user_id, test_id, deadline_at) for
-- `mode = 'exam' and submitted_at is null`, which is exactly the rows
-- `has_open_exam()` counts, so no new index is needed. Named here so the next
-- reader does not go looking for one.
