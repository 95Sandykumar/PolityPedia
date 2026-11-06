-- 0038_ai_claim_secret.sql  (issue 37-ai-claim-secret)
--
-- A CLAIM CARRIES A ONE-TIME SECRET.
--
-- 0032 keyed `finish_*` and `fail_*` on `claimed_by = auth.uid()`. That
-- closed the hole it was written for: another student can no longer end, or
-- poison, a call they did not pay for. It left the OTHER half open, and the
-- other half is where the money is.
--
--   THE APP HAS NO SERVICE-ROLE KEY. Every Supabase call in
--   `src/lib/ai/supabase-ai-client.ts` and
--   `src/lib/ai/supabase-audio-client.ts` carries the STUDENT'S OWN access
--   token, on purpose, so Postgres decides everything for the right person.
--   The cost of that choice is that `claimed_by = auth.uid()` is just as
--   true in the student's browser as it is in our route handler. So:
--
--     1. open Revision. /api/revision claims, and our server starts waiting
--        on Claude.
--     2. from the browser, post `rpc/fail_ai_explanation` for that same
--        question. `claimed_by` IS you, so the row is released and the 1 of
--        30 comes back.
--     3. reload. Claim again.
--
--   Three cycles, three Claude calls, a daily count that never leaves 0. The
--   30-a-day cap (X6) was the only thing bounding the model spend, so the
--   cap was the product's cost ceiling and it did not hold.
--   `fail_explanation_audio` had the same shape, against the paid voice.
--
-- THE FIX: a claim now has a SECRET, a fresh uuid, and the ONLY call ever
-- told it is the one that created or took over that claim. `finish_*` and
-- `fail_*` need the matching secret as well as `claimed_by`. Our route keeps
-- it in a local variable for the length of one model call and never puts it
-- in a reply or a log (`src/lib/ai/revision-route.ts`).
--
-- The browser can still post `rpc/claim_ai_explanation` and will be handed a
-- secret. It buys nothing: that claim leaves the row on `generating`, so our
-- route's own claim answers `generating`, makes NO model call, and spends no
-- money. The attacker has paid 1 of their 30 for an explanation they did not
-- get. The incentive is gone.
--
-- ONLY THE HASH IS STORED. `ai_explanations` is readable (0022's row-level
-- select policy plus the table-wide API grant Supabase gives `authenticated`),
-- and a column-level REVOKE would not change that: in Postgres a table-wide
-- SELECT already covers every column, present and future. So rather than
-- pretend, the column holds `sha256(secret)` and nothing else. A v4 uuid is
-- 122 random bits; there is no dictionary and no shortcut from the hash back
-- to the secret, and a guess costs a round trip for a 1-in-2^122 chance.
--
-- Also here, because it is the same row and the same money:
--
--   THE TAKEOVER REFUND RACE. 0032 read the stale row with NO lock, decided
--   from that read that a refund was owed, and only then ran the upsert. The
--   first claimant's own `fail`, committing inside that window, was refunded
--   by itself AND again by the takeover: two refunds for one call. The
--   authoritative read is now `select ... for update`, so a concurrent
--   `fail` waits, and then finds the claim is somebody else's.
--
-- WHAT IS NOT HERE: no service-role key (the issue forbids it, and it would
-- re-open a worse hole), no change to the exam locks of 0037, no webhook and
-- no session work.
--
-- The RETURN TYPE of both claim functions changes from `text` to `jsonb`,
-- because one call has to hand back the word AND the secret in the same
-- transaction. `create or replace` cannot change a return type, so each is
-- dropped first. The old `finish_*` / `fail_*` signatures are dropped too:
-- leaving them behind would leave the hole behind with them.

-- ---------------------------------------------------------------------------
-- 1. Where the secret lives
-- ---------------------------------------------------------------------------
--
-- Two columns, one per claim, beside the four `claimed_*` columns 0032 added.
-- A column on the row the claim is on, not a side table: the takeover already
-- holds this row under `for update`, so the secret rotates inside the same
-- lock as the claim it belongs to, with nothing to keep in step.
alter table public.ai_explanations
  add column if not exists claim_secret_hash text;
alter table public.ai_explanations
  add column if not exists audio_claim_secret_hash text;

comment on column public.ai_explanations.claim_secret_hash is
  'sha256 of the one-time secret handed to the call that claimed this explanation. finish_ai_explanation() and fail_ai_explanation() need the matching secret. Readable, and useless: it is a hash of 122 random bits. Issue 37-ai-claim-secret.';
comment on column public.ai_explanations.audio_claim_secret_hash is
  'sha256 of the one-time secret handed to the call that claimed this explanation''s voice call. Same rule, same reason. Issue 37-ai-claim-secret.';

-- `sha256()` is built in (Postgres 11+), so there is no pgcrypto to install
-- and nothing to enable in a Supabase project.
--
-- NOT granted to `anon` or `authenticated`: a client has no business hashing
-- anything, and a SECURITY DEFINER caller runs as the owner, which already
-- has EXECUTE. Supabase (and the test harness) grant EXECUTE on new public
-- functions by default, so the revoke has to be spelled out.
create or replace function public.ai_claim_secret_hash(secret uuid)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
           when secret is null then null
           else encode(sha256(secret::text::bytea), 'hex')
         end
$$;

comment on function public.ai_claim_secret_hash(uuid) is
  'sha256 of a claim secret as lower-case hex, or NULL for a NULL secret (so a missing secret can never match a stored hash). Issue 37-ai-claim-secret.';

revoke all on function public.ai_claim_secret_hash(uuid) from public;
revoke all on function public.ai_claim_secret_hash(uuid) from anon;
revoke all on function public.ai_claim_secret_hash(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- 2. The old signatures go
-- ---------------------------------------------------------------------------
--
-- In order, because `claim_*` is what issues a secret and the others are what
-- check it. Each `drop` takes its GRANT with it, so there is no leftover
-- function a browser can post the pre-37 argument list to.
drop function if exists public.claim_ai_explanation(uuid, text);
drop function if exists public.finish_ai_explanation(
  uuid, text, jsonb, jsonb, text, integer, integer, integer
);
drop function if exists public.fail_ai_explanation(uuid, text);
drop function if exists public.claim_explanation_audio(uuid, text);
drop function if exists public.finish_explanation_audio(uuid, text, text);
drop function if exists public.fail_explanation_audio(uuid, text);

-- ---------------------------------------------------------------------------
-- 3. claim_ai_explanation: the same gates, a row lock, and a secret
-- ---------------------------------------------------------------------------
--
-- The 0037 function with THREE changes and nothing else:
--
--   a. it returns `jsonb`: `{"code": "<word>"}`, plus `"secret"` on, and only
--      on, `claimed`. The WORD LIST is unchanged
--      (no_plan | not_found | ready | generating | limit | claimed), so
--      `ClaimCode`, `RevisionError`, the label map and both i18n tables are
--      untouched.
--   b. the read that the refund and the charge are decided from is
--      `select ... for update`. The cheap read above it stays lock-free, so
--      the two FREE answers (a saved explanation, somebody else's fresh
--      call) never queue behind a lock on a popular question. Everything
--      after the lock is re-checked, because the lock is what makes the
--      answer authoritative.
--   c. the claim stamps `claim_secret_hash`, in the same statement as
--      `claimed_by`. A takeover therefore REPLACES the hash, which is what
--      makes the first claimant's secret stop working.
create or replace function public.claim_ai_explanation(question_id uuid, lang text)
returns jsonb
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
  -- Generated up front, returned only if this call wins. `gen_random_uuid()`
  -- is v4: 122 random bits from the server's CSPRNG, never from the client.
  secret     uuid := gen_random_uuid();
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
    return jsonb_build_object('code', 'no_plan');
  end if;

  -- F-F6: the AI plan or Pro. Passing `caller` keeps it honest inside a
  -- definer, where the caller's own entitlements policy does not filter.
  if not public.can_use(caller, 'ai') then
    return jsonb_build_object('code', 'no_plan');
  end if;

  -- RLS is off inside a definer, so the visibility rule is spelled out here:
  -- a live question (any student) or the caller's own draft (its teacher).
  select q.teacher_id, q.status = 'live', q.test_id
  into owner, live, qtest
  from public.questions q
  where q.id = qid;

  if owner is null then
    return jsonb_build_object('code', 'not_found');
  end if;
  if not live and owner <> caller then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- THE MOCK PAYWALL. The same rule `questions_mock_needs_access` (0016) puts
  -- on reading the question itself, through the same one function, so there is
  -- no second copy to drift. Without it a student who never bought the set
  -- could read its questions' explanations, which quote the question.
  if qtest is not null and owner <> caller and not public.has_test_access(qtest) then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- THE OPEN SITTING, not the clock (issue 36-exam-leaks-close). `prompt.ts`
  -- sends the correct option to the model and the reply says which one it is,
  -- so during a sitting on this question's own test or paper that reply IS
  -- the answer key, mid-paper. ONE definition of open, shared with
  -- question_keys() and practice_verdict(): not submitted, deadline or no
  -- deadline.
  --
  -- `mode = 'exam'` only, inside the helper: practice mode marks every answer
  -- as it is tapped, so there is nothing left to leak and Revision stays open.
  if public.has_open_exam_for_question(qid) then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- THE CHEAP READ. No lock, because the two answers it can give cost
  -- nothing and change nothing: a saved explanation, or somebody's fresh
  -- call. Those are the common cases on a popular question, and making them
  -- queue behind a row lock would be a throughput bug for no gain.
  -- `coalesce(claimed_at, created_at)` covers a row written before 0032: it
  -- has no claimant, so it is treated as claimed when it was created and
  -- becomes takeable like any other.
  select e.status, coalesce(e.claimed_at, e.created_at)
  into found, prev_at
  from public.ai_explanations e
  where e.question_id = qid
    and e.lang = qlang;

  if found = 'ready' then
    return jsonb_build_object('code', 'ready');
  end if;
  if found = 'generating' and prev_at > now() - public.ai_claim_timeout() then
    return jsonb_build_object('code', 'generating');
  end if;

  -- THE AUTHORITATIVE READ (issue 37-ai-claim-secret). Everything below this
  -- line either charges somebody 1 of their 30 or gives somebody's back, so
  -- it may not run on a row another transaction is still changing.
  --
  -- `for update` is the whole fix for the double refund: the first claimant's
  -- own `fail_ai_explanation` now WAITS here, and when it gets the row the
  -- claim is already ours, so it refuses and refunds nothing. 0032 read this
  -- row unlocked, so that `fail` could slip between the read and the upsert
  -- and the same call was paid back twice.
  --
  -- No rows is not an error: the explanation does not exist yet, and the
  -- primary key below is what picks the one winner in that case.
  select e.status, e.claimed_by, coalesce(e.claimed_at, e.created_at)
  into found, prev_owner, prev_at
  from public.ai_explanations e
  where e.question_id = qid
    and e.lang = qlang
  for update;

  -- Re-checked under the lock, because the cheap read above is only a hint.
  -- Somebody may have finished the explanation, or claimed it freshly, while
  -- we were waiting for the lock.
  if found = 'ready' then
    return jsonb_build_object('code', 'ready');
  end if;
  if found = 'generating' and prev_at > now() - public.ai_claim_timeout() then
    return jsonb_build_object('code', 'generating');
  end if;

  -- Only a NEW explanation is counted, so the check sits here and nowhere
  -- earlier. A student at their cap can still read every saved one, and
  -- cannot take a stale claim over either: that would be a 31st call.
  select coalesce(u.new_count, 0) into used
  from public.ai_usage u
  where u.user_id = caller and u.ist_date = today;

  if coalesce(used, 0) >= public.ai_daily_cap() then
    return jsonb_build_object('code', 'limit');
  end if;

  -- THE RACE, with a third door. The primary key lets exactly one insert
  -- through; the conflict branch re-claims a `failed` row OR takes over a
  -- `generating` one whose claim has timed out. With the lock above, an
  -- EXISTING row can only be reached by one of us at a time; the insert's
  -- primary key is what still decides a brand-new row, where there was no
  -- row to lock.
  --
  -- `on constraint`, not `(question_id, lang)`: a bare column list in the
  -- conflict target is read as plpgsql identifiers first, and this function
  -- has parameters with those exact names.
  insert into public.ai_explanations (
    question_id, lang, status, claimed_by, claimed_at, claim_secret_hash
  )
  values (
    qid, qlang, 'generating', caller, now(), public.ai_claim_secret_hash(secret)
  )
  on conflict on constraint ai_explanations_pkey do update
    set status            = 'generating',
        body              = null,
        sources           = null,
        model             = null,
        tokens_in         = null,
        tokens_out        = null,
        searches          = null,
        claimed_by        = caller,
        claimed_at        = now(),
        -- A NEW secret, so the previous claimant's is dead from this moment.
        claim_secret_hash = public.ai_claim_secret_hash(secret)
    where public.ai_explanations.status = 'failed'
       or (
         public.ai_explanations.status = 'generating'
         and coalesce(public.ai_explanations.claimed_at, public.ai_explanations.created_at)
             <= now() - public.ai_claim_timeout()
       );

  get diagnostics claimed = row_count;

  if claimed = 0 then
    -- Lost the race for a row that did not exist when we looked. Nothing is
    -- counted: this student is not paying for somebody else's call, and no
    -- secret is handed out, because no claim is ours.
    select e.status into found
    from public.ai_explanations e
    where e.question_id = qid
      and e.lang = qlang;
    return jsonb_build_object('code', coalesce(found, 'generating'));
  end if;

  -- A TAKEOVER, so the first claimant pays for nothing. EXACTLY once, and now
  -- provably so: we have held this row since before we read `prev_owner`, so
  -- their own `fail` either committed before our read (in which case `found`
  -- is `failed`, not `generating`, and this branch is skipped because they
  -- already refunded themselves) or it is still waiting for the lock (in
  -- which case it will find the claim is ours and refuse). The refund goes to
  -- the India day the claim was CHARGED, which may not be today.
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

  -- THE ONE TIME THE SECRET IS EVER SAID OUT LOUD. The caller holds it in
  -- memory for the length of one model call. Nothing reads it back out of the
  -- database, because only its hash is there.
  return jsonb_build_object('code', 'claimed', 'secret', secret);
end;
$$;

comment on function public.claim_ai_explanation(uuid, text) is
  'One transaction: plan gate, question visibility, mock paywall, open-exam refusal through has_open_exam_for_question(), saved lookup, 30-a-day check, and the insert whose primary key decides who calls the model. The read that money is decided from is FOR UPDATE, so a takeover refunds the previous claimant exactly once. Returns jsonb {"code": no_plan | not_found | ready | generating | limit | claimed} plus "secret" on claimed only, which finish_ai_explanation() and fail_ai_explanation() then require. Issues 22-revision-api, 32-ai-claim-tokens, 36-exam-leaks-close, 37-ai-claim-secret.';

grant execute on function public.claim_ai_explanation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. finish_ai_explanation: the claimant, holding the secret
-- ---------------------------------------------------------------------------
--
-- `claim_secret` is the ninth argument and defaults to NULL, so a caller that
-- still posts the pre-37 eight-argument body resolves to this function and is
-- REFUSED rather than erroring: `ai_claim_secret_hash(null)` is NULL, and
-- `claim_secret_hash = null` is never true. Fail closed, with no new error
-- path for the route to handle.
--
-- NOTHING IS REFUNDED HERE, in any branch. A finished call was made and
-- billed. A refund may only ever come from a failure before there was text.
create or replace function public.finish_ai_explanation(
  question_id   uuid,
  lang          text,
  body          jsonb,
  sources       jsonb,
  model         text,
  tokens_in     integer,
  tokens_out    integer,
  searches      integer,
  claim_secret  uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid     uuid := finish_ai_explanation.question_id;
  qlang   text := finish_ai_explanation.lang;
  jbody   jsonb := finish_ai_explanation.body;
  jsrc    jsonb := finish_ai_explanation.sources;
  mdl     text := finish_ai_explanation.model;
  tin     integer := finish_ai_explanation.tokens_in;
  tout    integer := finish_ai_explanation.tokens_out;
  nsrch   integer := finish_ai_explanation.searches;
  csecret uuid := finish_ai_explanation.claim_secret;
  caller  uuid := auth.uid();
  clean   jsonb;
  saved   integer;
begin
  if caller is null then
    return false;
  end if;
  -- Cheap and explicit: no secret, no save. The UPDATE below would refuse it
  -- anyway, and saying so here is what makes the rule readable.
  if csecret is null then
    return false;
  end if;

  -- Normalise the sources instead of refusing the whole reply: the
  -- explanation a student paid for is still useful without one bad link, and
  -- the CHECK from 0032 would otherwise turn a stray `javascript:` into a
  -- lost call. A non-array `sources` is an empty list, not an error.
  if jsonb_typeof(jsrc) = 'array' then
    select coalesce(jsonb_agg(s), '[]'::jsonb) into clean
    from jsonb_array_elements(jsrc) as s
    where jsonb_typeof(s) = 'object'
      and jsonb_typeof(s -> 'url') = 'string'
      and (s ->> 'url' like 'http://%' or s ->> 'url' like 'https://%');
  else
    clean := '[]'::jsonb;
  end if;

  update public.ai_explanations e
  set status     = 'ready',
      body       = jbody,
      sources    = clean,
      model      = mdl,
      tokens_in  = tin,
      tokens_out = tout,
      searches   = nsrch
  where e.question_id = qid
    and e.lang = qlang
    -- Still in flight, so a late reply cannot overwrite a teacher's
    -- correction (0024) ...
    and e.status = 'generating'
    -- ... it is YOUR call (issue 32), so another student cannot write the
    -- text every future student will read ...
    and e.claimed_by = caller
    -- ... and you are the CALL that was given the claim, not just the person
    -- it was given to (issue 37). This is what the browser cannot forge.
    and e.claim_secret_hash is not null
    and e.claim_secret_hash = public.ai_claim_secret_hash(csecret);

  get diagnostics saved = row_count;
  return saved = 1;
end;
$$;

comment on function public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer, uuid) is
  'Save a finished explanation. Only a generating row, only the CLAIMANT, only with the one-time secret that claim_ai_explanation() returned, and only http(s) sources are stored. Never refunds. A call with no secret is refused, so a pre-37 argument list fails closed. Issues 22-revision-api, 32-ai-claim-tokens, 37-ai-claim-secret.';

grant execute on function
  public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. fail_ai_explanation: the refund needs the secret
-- ---------------------------------------------------------------------------
--
-- This is the function the whole issue is about. `auth.uid()` was never going
-- to be enough here, because the attacker IS the uid: they paid for the
-- claim, so they own it, and owning it was the only test.
--
-- The refund can only happen when this statement moved a row from
-- `generating` to `failed`, which happens at most once per claim, and a
-- `generating` row has no body yet. So "only when the call failed before any
-- text was produced" holds by construction.
--
-- The hash is CLEARED on the way out, so the secret is single use in the
-- strongest sense: even if the row were somehow re-claimed with the same
-- state, the old secret is no longer stored anywhere.
create or replace function public.fail_ai_explanation(
  question_id  uuid,
  lang         text,
  claim_secret uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid     uuid := fail_ai_explanation.question_id;
  qlang   text := fail_ai_explanation.lang;
  csecret uuid := fail_ai_explanation.claim_secret;
  caller  uuid := auth.uid();
  charged date;
  moved   integer;
begin
  if caller is null then
    return false;
  end if;
  -- NO SECRET, NO REFUND. A browser posting {question_id, lang} lands here,
  -- which is exactly the call this migration exists to refuse.
  if csecret is null then
    return false;
  end if;

  -- `returning ... into` reads the claim's own moment out of the row it just
  -- moved, in the same statement, so the refund cannot be aimed at the wrong
  -- India day by a clock that rolled over in between.
  update public.ai_explanations e
  set status            = 'failed',
      -- Single use. Nothing can replay this secret, on this row, ever.
      claim_secret_hash = null
  where e.question_id = qid
    and e.lang = qlang
    and e.status = 'generating'
    and e.claimed_by = caller
    and e.claim_secret_hash is not null
    and e.claim_secret_hash = public.ai_claim_secret_hash(csecret)
  returning public.ist_date_of(coalesce(e.claimed_at, e.created_at)) into charged;

  get diagnostics moved = row_count;

  -- Nothing of yours was in flight under this secret, so there is nothing to
  -- refund. Refunding anyway is the free call this issue is closing.
  if moved = 0 then
    return false;
  end if;

  update public.ai_usage u
  set new_count = greatest(u.new_count - 1, 0)
  where u.user_id = caller
    and u.ist_date = coalesce(charged, public.ist_today());

  return true;
end;
$$;

comment on function public.fail_ai_explanation(uuid, text, uuid) is
  'Mark YOUR OWN generating explanation failed and give that 1 of 30 back, on the India day it was charged, in one transaction. Needs the one-time secret claim_ai_explanation() returned as well as claimed_by, so the claimant''s own browser cannot refund a call our server is still making. The secret is cleared on success. Issues 22-revision-api, 32-ai-claim-tokens, 37-ai-claim-secret.';

grant execute on function public.fail_ai_explanation(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. claim_explanation_audio: the same secret, in the same statement
-- ---------------------------------------------------------------------------
--
-- The 0037 function with TWO changes: it returns `jsonb` the way the text
-- claim does, and the UPDATE that wins the race also stamps
-- `audio_claim_secret_hash`.
--
-- NO `for update` here, and that is not an oversight. The audio claim is a
-- single conditional UPDATE whose `row_count` names one winner, so it is
-- already atomic, and NOTHING IS EVER REFUNDED for audio (it is not on the
-- 30-a-day counter, because an explanation's narration is made once forever).
-- There is no double-refund to prevent, so there is no lock to take.
-- The word list is unchanged: not_found | not_ready | ready | making |
-- claimed.
create or replace function public.claim_explanation_audio(question_id uuid, lang text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid      uuid := claim_explanation_audio.question_id;
  qlang    text := claim_explanation_audio.lang;
  caller   uuid := auth.uid();
  secret   uuid := gen_random_uuid();
  state    text;
  astate   text;
  apath    text;
  aclaimed timestamptz;
  owner    uuid;
  live     boolean;
  taken    integer;
begin
  if caller is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  select e.status, e.audio_status, e.audio_path,
         coalesce(e.audio_claimed_at, e.created_at)
  into state, astate, apath, aclaimed
  from public.ai_explanations e
  where e.question_id = qid
    and e.lang = qlang;

  if state is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- RLS is off inside a definer, so the visibility rule from 0022 is spelled
  -- out again: a live question (any student) or the caller's own draft.
  select q.teacher_id, q.status = 'live'
  into owner, live
  from public.questions q
  where q.id = qid;

  if owner is null then
    return jsonb_build_object('code', 'not_found');
  end if;
  if not live and owner <> caller then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- THE OPEN SITTING (issue 36-exam-leaks-close). The audio reads the saved
  -- explanation out loud, and that text names the correct option, so the
  -- same gate the text claim has belongs here. The same one definition of
  -- open: not submitted, deadline or no deadline.
  if public.has_open_exam_for_question(qid) then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- There is nothing to read out until the model has finished writing.
  if state <> 'ready' then
    return jsonb_build_object('code', 'not_ready');
  end if;

  if astate = 'ready' and apath is not null then
    return jsonb_build_object('code', 'ready');
  end if;
  -- A FRESH voice call is in flight. A STALE one falls through and is taken
  -- over below, so a dead function cannot silence an explanation forever.
  if astate = 'making' and aclaimed > now() - public.ai_claim_timeout() then
    return jsonb_build_object('code', 'making');
  end if;

  -- THE RACE. Two students opened the same explanation at the same instant,
  -- both read `none` above. This UPDATE matches at most one of them, because
  -- the first one to commit leaves a fresh `audio_claimed_at` behind. The new
  -- secret goes on in the same statement, so a takeover kills the previous
  -- caller's secret at the instant it takes their claim.
  update public.ai_explanations e
  set audio_status            = 'making',
      audio_claimed_by        = caller,
      audio_claimed_at        = now(),
      audio_claim_secret_hash = public.ai_claim_secret_hash(secret)
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
    return jsonb_build_object('code', 'claimed', 'secret', secret);
  end if;

  -- Lost the race. Say what the winner is doing, so the caller waits instead
  -- of paying for the same words twice. No secret: the claim is not ours.
  select e.audio_status into astate
  from public.ai_explanations e
  where e.question_id = qid
    and e.lang = qlang;

  if astate = 'ready' then
    return jsonb_build_object('code', 'ready');
  end if;
  return jsonb_build_object('code', 'making');
end;
$$;

comment on function public.claim_explanation_audio(uuid, text) is
  'One transaction: question visibility, open-exam refusal through has_open_exam_for_question(), text readiness, and the UPDATE whose row_count decides who calls the voice. Returns jsonb {"code": not_found | not_ready | ready | making | claimed} plus "secret" on claimed only, which finish_explanation_audio() and fail_explanation_audio() then require. Issues 25-revision-audio, 32-ai-claim-tokens, 36-exam-leaks-close, 37-ai-claim-secret.';

grant execute on function public.claim_explanation_audio(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. finish_explanation_audio: the claimant, its own folder, and the secret
-- ---------------------------------------------------------------------------
--
-- Three refusals kept from 0032 (the claimant, a row still `making`, and a
-- path inside `explanations/<question id>/` with no `..` anywhere), plus the
-- secret. `claim_secret` defaults to NULL so a pre-37 three-argument call
-- fails closed.
create or replace function public.finish_explanation_audio(
  question_id  uuid,
  lang         text,
  audio_path   text,
  claim_secret uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid     uuid := finish_explanation_audio.question_id;
  qlang   text := finish_explanation_audio.lang;
  apath   text := nullif(btrim(finish_explanation_audio.audio_path), '');
  csecret uuid := finish_explanation_audio.claim_secret;
  caller  uuid := auth.uid();
  folder  text;
  saved   integer;
begin
  if caller is null then
    return false;
  end if;
  if csecret is null then
    return false;
  end if;
  -- An empty path is refused rather than stored: `ready` promises a playable
  -- file, and a blank path would be a player that 404s.
  if apath is null then
    return false;
  end if;

  folder := 'explanations/' || qid::text || '/';
  -- A uuid holds no LIKE wildcard, so the prefix test needs no escaping.
  if apath not like folder || '%' then
    return false;
  end if;
  if position('..' in apath) > 0 then
    return false;
  end if;

  update public.ai_explanations e
  set audio_path   = apath,
      audio_status = 'ready'
  where e.question_id = qid
    and e.lang = qlang
    and e.audio_status = 'making'
    and e.audio_claimed_by = caller
    and e.audio_claim_secret_hash is not null
    and e.audio_claim_secret_hash = public.ai_claim_secret_hash(csecret);

  get diagnostics saved = row_count;
  return saved = 1;
end;
$$;

comment on function public.finish_explanation_audio(uuid, text, text, uuid) is
  'Save the Storage path of a finished audio file. Only a row that is still making, only the CLAIMANT, only with the one-time secret claim_explanation_audio() returned, and only a path inside explanations/<question id>/. Issues 25-revision-audio, 32-ai-claim-tokens, 37-ai-claim-secret.';

grant execute on function public.finish_explanation_audio(uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. fail_explanation_audio: releasing a slot needs the secret too
-- ---------------------------------------------------------------------------
--
-- Nothing is refunded (audio is not on the 30-a-day counter), so the hole
-- here is not a free call, it is a PAID one: release a voice call that is
-- still running and the next read starts a second one for the same words,
-- billed per character. `auth.uid()` did not stop the claimant doing that to
-- their own in-flight call, over and over.
create or replace function public.fail_explanation_audio(
  question_id  uuid,
  lang         text,
  claim_secret uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid     uuid := fail_explanation_audio.question_id;
  qlang   text := fail_explanation_audio.lang;
  csecret uuid := fail_explanation_audio.claim_secret;
  caller  uuid := auth.uid();
  moved   integer;
begin
  if caller is null then
    return false;
  end if;
  if csecret is null then
    return false;
  end if;

  update public.ai_explanations e
  set audio_status            = 'failed',
      -- Single use, the same as the text claim.
      audio_claim_secret_hash = null
  where e.question_id = qid
    and e.lang = qlang
    and e.audio_status = 'making'
    and e.audio_claimed_by = caller
    and e.audio_claim_secret_hash is not null
    and e.audio_claim_secret_hash = public.ai_claim_secret_hash(csecret);

  get diagnostics moved = row_count;
  return moved = 1;
end;
$$;

comment on function public.fail_explanation_audio(uuid, text, uuid) is
  'Release YOUR OWN claimed audio slot so a later read may retry it. Needs the one-time secret claim_explanation_audio() returned, so the claimant''s browser cannot cancel a voice call that is still running and make us pay for a second one. Nothing is refunded: audio is not on the 30-a-day counter. Issues 25-revision-audio, 32-ai-claim-tokens, 37-ai-claim-secret.';

grant execute on function public.fail_explanation_audio(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. A teacher edit does not inherit a secret
-- ---------------------------------------------------------------------------
--
-- 0032's trigger pins everything a correction may not change and added the
-- four claim columns to that list. The two hash columns join them, for the
-- same reason: `ai_explanations_update_own` lets a teacher write their own
-- question's explanation row, and an edit that put a hash THEY chose on the
-- row would be handing themselves a claim secret.
--
-- It cannot be exploited today, because this trigger also forces
-- `status = 'ready'` and `finish_ai_explanation` needs `generating`. Pinned
-- anyway: the pin is what keeps it true when a later slice changes one of
-- those two facts.
create or replace function public.ai_explanation_teacher_edit()
returns trigger
language plpgsql
as $$
begin
  -- Identity. Without this an update could move the correction onto another
  -- question, or into the other language.
  new.question_id := old.question_id;
  new.lang        := old.lang;
  new.created_at  := old.created_at;

  -- A corrected explanation is readable, full stop. This also closes the
  -- retry hole: parked in `generating` the row could be overwritten by a late
  -- `finish_ai_explanation()`, and parked in `failed` it could be re-claimed.
  new.status := 'ready';

  -- Cost and provenance belong to the call that was paid for (AS3, H3).
  new.model      := old.model;
  new.tokens_in  := old.tokens_in;
  new.tokens_out := old.tokens_out;
  new.searches   := old.searches;

  -- Sources came out of the model's web search. Editing them is not in this
  -- slice, so they are pinned rather than silently half-trusted.
  new.sources := old.sources;

  -- A claim belongs to whoever paid for the call (issue 32), and its secret
  -- belongs to the call itself (issue 37).
  new.claimed_by        := old.claimed_by;
  new.claimed_at        := old.claimed_at;
  new.claim_secret_hash := old.claim_secret_hash;

  -- Narration (issue 25) is read aloud from `body`. New text means the old
  -- audio is now wrong, and wrong audio is worse than none, so the whole
  -- audio state goes back to "nobody has made it", secret included.
  if new.body is distinct from old.body then
    new.audio_path              := null;
    new.audio_status            := 'none';
    new.audio_claimed_by        := null;
    new.audio_claimed_at        := null;
    new.audio_claim_secret_hash := null;
  else
    new.audio_path              := old.audio_path;
    new.audio_status            := old.audio_status;
    new.audio_claimed_by        := old.audio_claimed_by;
    new.audio_claimed_at        := old.audio_claimed_at;
    new.audio_claim_secret_hash := old.audio_claim_secret_hash;
  end if;

  return new;
end;
$$;

comment on function public.ai_explanation_teacher_edit() is
  'Pins everything a teacher edit may not change: the row identity, the ready status, the model and token columns, the claim and its secret hash. Resets the whole audio state, secret hash included, when the text changes. Issues 24-revision-teacher-edit, 32-ai-claim-tokens, 37-ai-claim-secret.';

-- ---------------------------------------------------------------------------
-- 10. RLS
-- ---------------------------------------------------------------------------
--
-- Nothing is added and nothing is widened. `ai_explanations` still has NO
-- insert policy and no student update policy, so every claim column, the two
-- hash columns included, can only ever move inside the functions above. That
-- is what makes both checks meaningful: a student cannot write
-- `claimed_by = me, claim_secret_hash = sha256(mine)` and then finish.
--
-- The hash columns ARE selectable, to anybody who may read the row. That is
-- the design, not a gap: a table-wide SELECT grant in Postgres covers every
-- column, so a column-level REVOKE would be theatre. What is stored is
-- `sha256` of 122 random bits, which answers no question the reader did not
-- already know.
