-- 0037_exam_leaks_close.sql  (issue 36-exam-leaks-close)
--
-- F-E5, THE THIRD TIME. 0030 moved the answer-key rule into Postgres and 0036
-- joined it to the practice verdict. An independent re-check then PROVED, with
-- PGlite probes, that the key still left the building FOUR ways. Each one is a
-- different door into the same room, so all four close here.
--
--  1. DELETE THE SITTING. `attempts_delete_own` (0013:105) let a student
--     delete their own unsubmitted exam attempt. With the row gone
--     `has_open_exam()` is false, so `question_keys()` answers,
--     `practice_verdict()` answers, `attempts_no_practice_during_exam` lets
--     the practice tab open, and a brand new sitting starts with a brand new
--     deadline. Every gate 0030 and 0036 built hangs off that one row, which
--     made the row the weakest thing in the design.
--
--  2. `questions.teacher_explanation`. 0030 revoked ONE column. The prose
--     beside it says "the Rajya Sabha, option B" in words, and
--     `src/lib/exam/types.ts:91` already lists the field as answer key:
--
--       GET {SUPABASE_URL}/rest/v1/questions?test_id=eq.<id>
--             &select=number,teacher_explanation
--
--  3. THE SAVED AI EXPLANATION. `ai_explanations_select_visible` (0022:409)
--     asked only "can you read the question", and the saved body quotes the
--     correct option by name. `claim_explanation_audio` (0032) had no exam
--     check at all, so the SPOKEN version of a ready explanation was
--     claimable mid-paper.
--
--  4. THE DEADLINE CLAUSE. `claim_ai_explanation` (0032:251) counted a
--     sitting as open only while `now() < deadline_at`. `has_open_exam()`
--     does not, on purpose: an unsubmitted paper is an unmarked paper. The
--     two definitions drifted, so after the deadline with no submit the model
--     call was allowed while the key stayed locked.
--
-- ONE DEFINITION OF "MID-EXAM", STILL. Everything below reaches
-- `public.has_open_exam()` from 0030, directly or through the one new helper
-- `has_open_exam_for_question()`. No file in this schema restates the rule.
--
-- WHAT DOES NOT CHANGE.
--
--  * `score_attempt()` (0018) and `practice_verdict()` (0036) read the key
--    themselves. Both are SECURITY DEFINER and own the table, so a column
--    privilege taken from `authenticated` is not their gate.
--  * A teacher still WRITES both the key and the explanation: `update` is a
--    different privilege from `select`, and `questions_update_own` (0011)
--    still decides whose row.
--  * Practice, Revision and the review screen are untouched OUTSIDE an open
--    exam sitting, which is the whole point.
--
-- NOT HERE: refunds and claim secrets (issue 37), webhooks, session code.

-- ---------------------------------------------------------------------------
-- 1. The sitting cannot be deleted out from under its own gate
-- ---------------------------------------------------------------------------
--
-- RESTRICTIVE, so it is ANDed with `attempts_delete_own` (0013) rather than
-- ORed with it. What a signed-in student may delete is now:
--
--   (their own row) AND (not an exam sitting that has never been submitted)
--
-- NO DEFINER FUNCTION IS ADDED, because nothing in the app deletes an
-- attempt: there is no `method: 'DELETE'` against `/rest/v1/attempts`
-- anywhere in `src/`, and a sitting is ended by `score_attempt()`, which
-- SUBMITS it. So this takes away a capability that only an attacker was
-- using.
--
-- WHAT STILL WORKS:
--
--   * a SUBMITTED exam sitting (`submitted_at is not null`) is deletable, so
--     a student can still clear their own history.
--   * a PRACTICE sitting is deletable, in any state.
--   * a PAST PAPER sitting is deletable: a past paper has no exam mode and no
--     key to protect (the same carve-out 0030 made for the insert gate).
--   * the OWNER and `service_role` are untouched: a restrictive policy binds
--     only the roles it names, and `authenticated` is the only one named.
--   * `on delete cascade` from `auth.users` still removes every attempt. A
--     cascade is performed by the system with the referencing table's own
--     rights, so RLS is not consulted and a deleted account still leaves
--     nothing behind.
create policy attempts_no_delete_open_exam on public.attempts
  as restrictive
  for delete to authenticated
  using (
    attempts.mode <> 'exam'
    or attempts.submitted_at is not null
  );

comment on policy attempts_no_delete_open_exam on public.attempts is
  'Leak 1 of the 2026-11-05 re-check: every exam gate in 0030 and 0036 asks has_open_exam(), which counts an unsubmitted exam attempt, so deleting that attempt unlocked the key, the practice tab and the verdict, and let a fresh sitting start with a fresh deadline. An unsubmitted exam sitting is therefore undeletable by its own student. RESTRICTIVE, so it narrows attempts_delete_own instead of widening it. Issue 36-exam-leaks-close.';

-- ---------------------------------------------------------------------------
-- 2a. The column privilege: nobody reads `teacher_explanation` either
-- ---------------------------------------------------------------------------
--
-- The same do-block shape as 0030, for the same reasons: a table-level
-- `select` covers every column including ones added later, a column cannot be
-- carved out of it, and the keep-list is read out of the catalogue rather than
-- typed so a typo cannot silently hide a column the player needs.
--
-- TWO exclusions now, and they are named once each. A column added by a later
-- migration is still granted automatically.
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
    and a.attname not in ('correct_idx', 'teacher_explanation');

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

comment on column public.questions.teacher_explanation is
  'The teacher''s prose explanation. IT IS ANSWER KEY MATERIAL: it says which option is right in words, which is why src/lib/exam/types.ts lists it beside correct_idx. NOT READABLE off this table by anon or authenticated (issue 36-exam-leaks-close): the column privilege was revoked, so the one way a client gets it is question_explanations(), which refuses while an exam sitting of that test is open (F-E5).';

-- ---------------------------------------------------------------------------
-- 2b. question_explanations(): the one way in, the twin of question_keys()
-- ---------------------------------------------------------------------------
--
-- A deliberate copy of `question_keys()` (0030) down to the error it raises,
-- because the two answer the same question about the same rows and must be
-- auditable side by side. Same readers:
--
--   * the practice player, after it has the paper (issue 17)
--   * the exam review, once the sitting is submitted (issue 18)
--   * the teacher's review and set-authoring screens (issues 11, 15, 24)
--
-- IT RAISES rather than returning fewer rows when the exam gate refuses, so
-- the practice page can tell the student to finish their exam first instead of
-- showing a paper with no explanations and no reason. The client maps the 403
-- onto the same `ExamKeyLocked` error it already handles.
--
-- A TEACHER IS NEVER LOCKED OUT of their own question: they wrote the prose.
create or replace function public.question_explanations(question_ids uuid[])
returns table (question_id uuid, teacher_explanation text)
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

  -- An empty or absent list is an empty answer, not a refusal: a test with no
  -- questions reads this way.
  if question_ids is null or array_length(question_ids, 1) is null then
    return;
  end if;

  -- F-E5. ONE locked test is enough to refuse the whole call, the same answer
  -- question_keys() gives to the same mixed list.
  select q.test_id into locked
  from public.questions q
  where q.id = any(question_ids)
    and q.test_id is not null
    and q.teacher_id <> caller
    and public.has_open_exam(q.test_id)
  limit 1;

  if locked is not null then
    raise exception 'the explanation is locked while an exam sitting is open'
      using errcode = 'insufficient_privilege';
  end if;

  -- The same three rules the SELECT policies state, spelled out because a
  -- definer function is not subject to them:
  --
  --   `questions_select_live`      (0011) -- own row, or live + approved
  --   `questions_mock_needs_access`(0016) -- a mock question needs the set
  return query
  select q.id, q.teacher_explanation
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

comment on function public.question_explanations(uuid[]) is
  'The teacher''s prose explanation for questions the caller has already read, and the ONLY way a client gets it (the column privilege on questions.teacher_explanation was revoked). The twin of question_keys(): same read rules, same refusal, same error code. RAISES insufficient_privilege while the caller has an open exam sitting for that test (F-E5). Issue 36-exam-leaks-close.';

revoke all on function public.question_explanations(uuid[]) from public, anon;
grant execute on function public.question_explanations(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3a. "Is this caller mid-exam on the paper this QUESTION belongs to?"
-- ---------------------------------------------------------------------------
--
-- One question id in, one boolean out. It exists so the `ai_explanations`
-- policy and both claim functions ask the question the same way, and so that
-- "mid-exam" still has exactly ONE definition: this calls
-- `public.has_open_exam()` from 0030 for the mock-test case.
--
-- THE PAST-PAPER BRANCH is kept from the clause 0032 had. A past paper has no
-- exam mode in the product today, so the branch matches nothing; it is here
-- because 0032 checked `a.paper_id` and removing a check while closing leaks
-- is not a trade this file is making. It uses the SAME "not submitted" rule as
-- `has_open_exam()` and no deadline, which is the whole of leak 4.
--
-- THE TEACHER IS EXEMPT, the same carve-out `question_keys()` makes: a
-- teacher trying out their own test is not a student cheating.
--
-- SECURITY DEFINER, like `has_open_exam()` and for the same reason: it is
-- called from inside a USING clause, so it must not depend on the caller's
-- own `attempts_select_own` or `questions_select_live` being evaluable at that
-- moment. It returns a boolean about a question id the caller already holds,
-- so there is no row to leak.
create or replace function public.has_open_exam_for_question(for_question uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.questions q
    where q.id = for_question
      and q.teacher_id is distinct from auth.uid()
      and (
        public.has_open_exam(q.test_id)
        or exists (
          select 1
          from public.attempts a
          where a.user_id = auth.uid()
            and a.paper_id = q.paper_id
            and a.mode = 'exam'
            and a.submitted_at is null
        )
      )
  )
$$;

comment on function public.has_open_exam_for_question(uuid) is
  'True while the signed-in user has an unsubmitted exam sitting of the mock test or past paper this question belongs to, and is not its teacher. Built on has_open_exam() (0030), so "mid-exam" still has one definition and no deadline clause. Used by ai_explanations_no_read_during_exam, claim_ai_explanation and claim_explanation_audio. Issue 36-exam-leaks-close.';

grant execute on function public.has_open_exam_for_question(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3b. No saved AI explanation while the exam runs
-- ---------------------------------------------------------------------------
--
-- RESTRICTIVE, so it is ANDed with `ai_explanations_select_visible` (0022):
--
--   (you can read the question) AND (you are not sitting its paper)
--
-- QUIET, not loud, unlike `question_explanations()`. An explanation that is
-- not there is the normal state of this table for most questions, so the
-- Revision panel already draws "nothing saved yet" and needs no new sentence
-- and no new label in two languages. The panel cannot ask for a NEW one
-- either: `claim_ai_explanation` answers `not_found` below.
--
-- THE REALTIME PUSH closes with it: `supabase-explanation-live.ts` subscribes
-- as the student, and Supabase Realtime evaluates the SELECT policies of the
-- table, so a row that finished generating mid-exam is not pushed either.
--
-- INSERT, UPDATE and the definer functions are untouched. Every `claim_*`,
-- `finish_*` and `fail_*` is SECURITY DEFINER and owns the table, so this
-- policy is not their gate and a call that was already in flight still saves.
create policy ai_explanations_no_read_during_exam on public.ai_explanations
  as restrictive
  for select to authenticated
  using (
    not public.has_open_exam_for_question(ai_explanations.question_id)
  );

comment on policy ai_explanations_no_read_during_exam on public.ai_explanations is
  'Leak 3 of the 2026-11-05 re-check: a saved explanation names the correct option in prose, and ai_explanations_select_visible only asked whether the question was visible. Zero rows while the caller has an open exam sitting for that question''s test or paper; the owning teacher is exempt. RESTRICTIVE, so it narrows ai_explanations_select_visible instead of widening it. Issue 36-exam-leaks-close.';

-- ---------------------------------------------------------------------------
-- 4a. claim_ai_explanation(): has_open_exam(), with no deadline clause
-- ---------------------------------------------------------------------------
--
-- Byte for byte the 0032 function with ONE block replaced: the inline
-- `exists (... and (a.deadline_at is null or now() < a.deadline_at) ...)`
-- becomes `public.has_open_exam_for_question(qid)`. Signature, word list,
-- order of the gates, counter behaviour and the takeover refund are all
-- unchanged, so every caller in `src/lib/ai/` keeps working.
--
-- WHY IT MATTERS: the old clause let the claim through the moment the clock
-- ran out, while `question_keys()` stayed locked until submit. `prompt.ts`
-- sends the correct option to the model, so the reply named the answer for a
-- paper that was still unmarked.
create or replace function public.claim_ai_explanation(question_id uuid, lang text)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  -- The parameters are copied into locals: their names match the COLUMN
  -- names, and inside `insert ... on conflict` plpgsql cannot tell the two
  -- apart. The parameter names stay as they are because they are the wire
  -- contract: Supabase RPC posts {"question_id": ..., "lang": ...}.
  qid        uuid := claim_ai_explanation.question_id;
  qlang      text := claim_ai_explanation.lang;
  caller     uuid := auth.uid();
  today      date := public.ist_today();
  owner      uuid;
  live       boolean;
  qtest      uuid;
  found      text;
  prev_owner uuid;
  prev_at    timestamptz;
  used       integer;
  claimed    integer;
begin
  if caller is null then
    return 'no_plan';
  end if;

  -- F-F6: the AI plan or Pro. Passing `caller` keeps it honest inside a
  -- definer, where the caller's own entitlements policy does not filter.
  if not public.can_use(caller, 'ai') then
    return 'no_plan';
  end if;

  -- RLS is off inside a definer, so the visibility rule is spelled out here:
  -- a live question (any student) or the caller's own draft (its teacher).
  select q.teacher_id, q.status = 'live', q.test_id
  into owner, live, qtest
  from public.questions q
  where q.id = qid;

  if owner is null then
    return 'not_found';
  end if;
  if not live and owner <> caller then
    return 'not_found';
  end if;

  -- THE MOCK PAYWALL. The same rule `questions_mock_needs_access` (0016) puts
  -- on reading the question itself, through the same one function, so there is
  -- no second copy to drift. Without it a student who never bought the set
  -- could read its questions' explanations, which quote the question.
  if qtest is not null and owner <> caller and not public.has_test_access(qtest) then
    return 'not_found';
  end if;

  -- THE OPEN SITTING, not the clock (issue 36-exam-leaks-close). `prompt.ts`
  -- sends the correct option to the model and the reply says which one it is,
  -- so during a sitting on this question's own test or paper that reply IS
  -- the answer key, mid-paper. ONE definition of open, shared with
  -- question_keys() and practice_verdict(): not submitted, deadline or no
  -- deadline. 0032 stopped refusing the moment the clock ran out, which was
  -- exactly the window in which the paper was still waiting to be marked.
  --
  -- `mode = 'exam'` only, inside the helper: practice mode marks every answer
  -- as it is tapped, so there is nothing left to leak and Revision stays open.
  if public.has_open_exam_for_question(qid) then
    return 'not_found';
  end if;

  -- The free, unlimited path. Checked BEFORE the counter, which is the whole
  -- point of saving explanations. `coalesce(claimed_at, created_at)` covers a
  -- row written before 0032: it has no claimant, so it is treated as claimed
  -- when it was created and becomes takeable like any other.
  select e.status, e.claimed_by, coalesce(e.claimed_at, e.created_at)
  into found, prev_owner, prev_at
  from public.ai_explanations e
  where e.question_id = qid
    and e.lang = qlang;

  if found = 'ready' then
    return 'ready';
  end if;
  -- A FRESH call is in flight: wait for it, pay nothing. A STALE one falls
  -- through to the takeover below.
  if found = 'generating' and prev_at > now() - public.ai_claim_timeout() then
    return 'generating';
  end if;

  -- Only a NEW explanation is counted, so the check sits here and nowhere
  -- earlier. A student at their cap can still read every saved one, and
  -- cannot take a stale claim over either: that would be a 31st call.
  select coalesce(u.new_count, 0) into used
  from public.ai_usage u
  where u.user_id = caller and u.ist_date = today;

  if coalesce(used, 0) >= public.ai_daily_cap() then
    return 'limit';
  end if;

  -- THE RACE, with a third door. The primary key lets exactly one insert
  -- through; the conflict branch re-claims a `failed` row OR takes over a
  -- `generating` one whose claim has timed out. Two callers arriving on the
  -- same stale row both reach this statement, and `row_count` still names one
  -- winner, because the loser's `claimed_at` test is false by then.
  --
  -- `on constraint`, not `(question_id, lang)`: a bare column list in the
  -- conflict target is read as plpgsql identifiers first, and this function
  -- has parameters with those exact names.
  insert into public.ai_explanations (question_id, lang, status, claimed_by, claimed_at)
  values (qid, qlang, 'generating', caller, now())
  on conflict on constraint ai_explanations_pkey do update
    set status     = 'generating',
        body       = null,
        sources    = null,
        model      = null,
        tokens_in  = null,
        tokens_out = null,
        searches   = null,
        claimed_by = caller,
        claimed_at = now()
    where public.ai_explanations.status = 'failed'
       or (
         public.ai_explanations.status = 'generating'
         and coalesce(public.ai_explanations.claimed_at, public.ai_explanations.created_at)
             <= now() - public.ai_claim_timeout()
       );

  get diagnostics claimed = row_count;

  if claimed = 0 then
    -- Lost the race. Nothing is counted: this student is not paying for
    -- somebody else's call.
    select e.status into found
    from public.ai_explanations e
    where e.question_id = qid
      and e.lang = qlang;
    return coalesce(found, 'generating');
  end if;

  -- A TAKEOVER, so the first claimant pays for nothing. Once: their claim is
  -- gone from the row by now, so `fail_ai_explanation` will refuse them, and
  -- a second taker cannot reach this line because the statement above would
  -- have matched nothing. The refund goes to the day the claim was CHARGED,
  -- which may not be today.
  if found = 'generating' and prev_owner is not null and prev_owner <> caller then
    update public.ai_usage u
    set new_count = greatest(u.new_count - 1, 0)
    where u.user_id = prev_owner
      and u.ist_date = public.ist_date_of(prev_at);
  end if;

  -- Won the race, so this one is on the counter. Same transaction as the
  -- insert above: a row in `generating` always has a paid-for call behind it.
  insert into public.ai_usage (user_id, ist_date, new_count)
  values (caller, today, 1)
  on conflict (user_id, ist_date) do update
    set new_count = public.ai_usage.new_count + 1;

  return 'claimed';
end;
$$;

comment on function public.claim_ai_explanation(uuid, text) is
  'One transaction: plan gate, question visibility, mock paywall, open-exam refusal through has_open_exam_for_question() with NO deadline clause, saved lookup, 30-a-day check, and the insert whose primary key decides who calls the model. Stamps claimed_by/claimed_at, and takes over a claim older than ai_claim_timeout() with a one-time refund. Returns no_plan | not_found | ready | generating | limit | claimed. Issues 22-revision-api, 32-ai-claim-tokens, 36-exam-leaks-close.';

grant execute on function public.claim_ai_explanation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4b. claim_explanation_audio(): the exam check it never had
-- ---------------------------------------------------------------------------
--
-- The 0032 function with ONE new gate, in the same place the text claim keeps
-- it: after the visibility rule, before anything is read or written. 0032
-- had no exam check here at all, so the SPOKEN version of a ready explanation
-- was claimable in the middle of a sitting, and the student heard the answer
-- read out to them.
--
-- `not_found` is the word, because it is already in the list and already
-- means "not yours to read now". No new code means nothing to add to
-- `ClaimCode`, the label map or either i18n table.
create or replace function public.claim_explanation_audio(question_id uuid, lang text)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid      uuid := claim_explanation_audio.question_id;
  qlang    text := claim_explanation_audio.lang;
  caller   uuid := auth.uid();
  state    text;
  astate   text;
  apath    text;
  aclaimed timestamptz;
  owner    uuid;
  live     boolean;
  taken    integer;
begin
  if caller is null then
    return 'not_found';
  end if;

  select e.status, e.audio_status, e.audio_path,
         coalesce(e.audio_claimed_at, e.created_at)
  into state, astate, apath, aclaimed
  from public.ai_explanations e
  where e.question_id = qid
    and e.lang = qlang;

  if state is null then
    return 'not_found';
  end if;

  -- RLS is off inside a definer, so the visibility rule from 0022 is spelled
  -- out again: a live question (any student) or the caller's own draft.
  select q.teacher_id, q.status = 'live'
  into owner, live
  from public.questions q
  where q.id = qid;

  if owner is null then
    return 'not_found';
  end if;
  if not live and owner <> caller then
    return 'not_found';
  end if;

  -- THE OPEN SITTING (issue 36-exam-leaks-close). The audio reads the saved
  -- explanation out loud, and that text names the correct option, so the
  -- same gate the text claim has belongs here. The same one definition of
  -- open: not submitted, deadline or no deadline.
  if public.has_open_exam_for_question(qid) then
    return 'not_found';
  end if;

  -- There is nothing to read out until the model has finished writing.
  if state <> 'ready' then
    return 'not_ready';
  end if;

  if astate = 'ready' and apath is not null then
    return 'ready';
  end if;
  -- A FRESH voice call is in flight. A STALE one falls through and is taken
  -- over below, so a dead function cannot silence an explanation forever.
  if astate = 'making' and aclaimed > now() - public.ai_claim_timeout() then
    return 'making';
  end if;

  -- THE RACE. Two students opened the same explanation at the same instant,
  -- both read `none` above. This UPDATE matches at most one of them, because
  -- the first one to commit leaves a fresh `audio_claimed_at` behind.
  update public.ai_explanations e
  set audio_status     = 'making',
      audio_claimed_by = caller,
      audio_claimed_at = now()
  where e.question_id = qid
    and e.lang = qlang
    and e.status = 'ready'
    and e.audio_path is null
    and (
      e.audio_status in ('none', 'failed')
      or (
        e.audio_status = 'making'
        and coalesce(e.audio_claimed_at, e.created_at) <= now() - public.ai_claim_timeout()
      )
    );

  get diagnostics taken = row_count;

  if taken = 1 then
    return 'claimed';
  end if;

  -- Lost the race. Say what the winner is doing, so the caller waits instead
  -- of paying for the same words twice.
  select e.audio_status into astate
  from public.ai_explanations e
  where e.question_id = qid
    and e.lang = qlang;

  if astate = 'ready' then
    return 'ready';
  end if;
  return 'making';
end;
$$;

comment on function public.claim_explanation_audio(uuid, text) is
  'One transaction: question visibility, open-exam refusal through has_open_exam_for_question() with NO deadline clause, text readiness, and the UPDATE whose row_count decides who calls the voice. Stamps audio_claimed_by/at and takes over a claim older than ai_claim_timeout(). Returns not_found | not_ready | ready | making | claimed. Issues 25-revision-audio, 32-ai-claim-tokens, 36-exam-leaks-close.';

grant execute on function public.claim_explanation_audio(uuid, text) to authenticated;
