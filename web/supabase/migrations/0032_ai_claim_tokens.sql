-- 0032_ai_claim_tokens.sql  (issue 32-ai-claim-tokens)
--
-- A CLAIM HAS AN OWNER.
--
-- 0022 and 0025 decide who may START a paid call, and they decide it well:
-- the primary key of `ai_explanations` is the race winner, so a question is
-- explained once. Neither file decided who may END that call. `finish_*` and
-- `fail_*` asked only "is anybody signed in", and both are SECURITY DEFINER
-- and granted to `authenticated`, so any student could post either one over
-- REST for a claim that is not theirs. Two holes followed, both found in the
-- 2026-11-05 review:
--
--   COST. Claim through /api/revision, then call `fail_ai_explanation`
--   yourself while the model is still writing. The count comes back, the row
--   is released, and the 30-a-day cap (X6) never fills. Every cycle spends a
--   Claude call.
--
--   POISONING. Poll for a `generating` row and call `finish_ai_explanation`
--   with your own body and your own `sources`. That text becomes the
--   permanent saved explanation for every student, and those links are
--   rendered as real anchors.
--
-- The fix is the same shape as the rest of the AI slice: the rule lives in
-- Postgres, not in a route handler, because the attack never touches our
-- route handler. Four new columns say WHO is in flight and SINCE WHEN, and
-- every `finish_*` / `fail_*` is keyed on `auth.uid() = <the claimant>`.
--
-- The function NAMES and SIGNATURES are unchanged, so every caller in
-- `src/lib/ai/` keeps working. `set search_path = public, auth, pg_temp`
-- stays on every one of them.
--
-- Also here, because the same claim is what each one is about:
--
--  * a claim older than `ai_claim_timeout()` is TAKEN OVER, and the first
--    claimant is given their 1 of 30 back exactly once. Without this a row
--    whose serverless function died is stuck on `generating` forever and the
--    question can never be explained.
--  * `claim_ai_explanation` now applies the mock paywall (`has_test_access`)
--    and refuses while the caller has an OPEN EXAM SITTING on that test. The
--    prompt quotes the correct option (`prompt.ts`), so answering during an
--    exam would hand the key over mid-paper.
--  * a source url is stored only when it is `http` or `https`. Enforced by a
--    CHECK on the table AND by normalisation inside `finish_ai_explanation`,
--    so neither a bad model reply nor a hand-posted REST call can store a
--    `javascript:` link. The render path has the same check
--    (`src/lib/ai/types.ts`).
--  * `finish_explanation_audio` takes a path only inside the folder that
--    belongs to that explanation id.
--
-- NOT here: the answer-key storage (ticket 30), the attempts table (ticket
-- 31), payments. This file only READS `attempts`.

-- --------------------------------------------------------------------------
-- How long a claim is believed
-- --------------------------------------------------------------------------
--
-- 2 minutes. Long enough for a Claude call with two web searches plus the
-- Vercel function's own `maxDuration`, short enough that a student who hit a
-- dead function can retry inside one sitting. One function, so the SQL and
-- the tests can never disagree about the window.
create or replace function public.ai_claim_timeout()
returns interval
language sql
immutable
as $$
  select interval '2 minutes'
$$;

comment on function public.ai_claim_timeout() is
  'How long a generating/making claim is believed before another caller may take it over. Issue 32-ai-claim-tokens.';

grant execute on function public.ai_claim_timeout() to authenticated;

-- The India day of a MOMENT, not of now().
--
-- `fail_ai_explanation` used `ist_today()`, which is wrong across midnight:
-- a claim made at 23:59 IST and refunded at 00:01 IST took the 1 off
-- TOMORROW's counter, where nothing had been added, and left yesterday's
-- charge standing. A takeover refund is worse again, because the stale claim
-- can be from any earlier day. Every refund now uses the day the claim was
-- MADE.
create or replace function public.ist_date_of(moment timestamptz)
returns date
language sql
immutable
as $$
  select (moment at time zone 'Asia/Kolkata')::date
$$;

comment on function public.ist_date_of(timestamptz) is
  'The India date one moment falls on. The counter a refund must go back to is the one the claim was charged to. Issue 32-ai-claim-tokens.';

grant execute on function public.ist_date_of(timestamptz) to authenticated;

-- --------------------------------------------------------------------------
-- Who holds the claim
-- --------------------------------------------------------------------------
--
-- `on delete set null`, not cascade: a deleted account must not take a saved
-- explanation every other student reads with it. The row then has no claimant
-- and no `finish_*` can land on it, which is right: nobody is in flight.
--
-- These four columns are readable by anybody who may read the row, because
-- the select policy from 0022 is row-level and the Supabase API role holds a
-- table-wide grant. A user id is all they reveal, and only for a question
-- that user could already be reading. Nothing is keyed on them being secret.
alter table public.ai_explanations
  add column if not exists claimed_by uuid references auth.users (id) on delete set null;
alter table public.ai_explanations
  add column if not exists claimed_at timestamptz;
alter table public.ai_explanations
  add column if not exists audio_claimed_by uuid references auth.users (id) on delete set null;
alter table public.ai_explanations
  add column if not exists audio_claimed_at timestamptz;

comment on column public.ai_explanations.claimed_by is
  'The user whose 1-of-30 paid for the call that is in flight. ONLY they may finish or fail it. Issue 32-ai-claim-tokens.';
comment on column public.ai_explanations.claimed_at is
  'When the in-flight claim was made. Older than ai_claim_timeout() means another caller may take it over, and the refund goes to ist_date_of(this). Issue 32-ai-claim-tokens.';
comment on column public.ai_explanations.audio_claimed_by is
  'The user whose voice call is in flight. ONLY they may finish or fail the audio. Issue 32-ai-claim-tokens.';
comment on column public.ai_explanations.audio_claimed_at is
  'When the audio claim was made, so a dead voice call does not leave an explanation silent forever. Issue 32-ai-claim-tokens.';

-- A stale claim is found by (status, claimed_at), nothing else.
create index if not exists ai_explanations_generating_idx
  on public.ai_explanations (claimed_at)
  where status = 'generating';

-- --------------------------------------------------------------------------
-- A source is a link we render
-- --------------------------------------------------------------------------
--
-- So `javascript:` and `data:` are not sources, they are an attack on the
-- student who taps them. The jsonpath asks "is there any element whose url is
-- missing, not a string, or not http(s)"; the constraint holds when there is
-- not. Same idiom as `questions_options_check` in 0011.
--
-- `coalesce(..., false)`: `@?` on a NULL `sources` is NULL, and a NULL CHECK
-- passes anyway, but spelling it out keeps the intent readable.
--
-- Lower case only, because that is what a parsed url gives back
-- (`new URL(x).toString()` and the normaliser below both lower-case the
-- scheme). A hand-written `HTTPS://` is refused rather than half-trusted.
alter table public.ai_explanations
  drop constraint if exists ai_explanations_sources_url_check;

alter table public.ai_explanations
  add constraint ai_explanations_sources_url_check check (
    sources is null
    or (
      jsonb_typeof(sources) = 'array'
      and not coalesce(
        sources @? '$[*] ? (@.url.type() != "string" || !(@.url starts with "http://" || @.url starts with "https://"))',
        false
      )
    )
  );

-- --------------------------------------------------------------------------
-- claim_ai_explanation: the same transaction, four more rules
-- --------------------------------------------------------------------------
--
-- Returns one word, and the caller does exactly what it says:
--
--   no_plan     -> refuse. Show the Rs 100 card.
--   not_found   -> refuse. Not readable to this caller RIGHT NOW: the
--                  question is a draft, or its mock set is not unlocked, or
--                  an exam sitting on that test is open.
--   ready       -> read the saved row. Costs nothing, counts nothing.
--   generating  -> somebody else is writing it, and their claim is fresh.
--   limit       -> refuse. 30 new ones used today; saved ones still work.
--   claimed     -> YOU call the model, then finish_ai_explanation().
--
-- The word list is unchanged on purpose. A new code would have to be added to
-- `ClaimCode`, `RevisionError`, the label map and both i18n tables to say
-- nothing a student can act on, and `not_found` already means "not yours to
-- read now". It also leaks nothing about which sets or sittings exist.
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
  qpaper     uuid;
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
  select q.teacher_id, q.status = 'live', q.test_id, q.paper_id
  into owner, live, qtest, qpaper
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

  -- THE EXAM CLOCK. `prompt.ts` sends the correct option to the model, and
  -- the answer comes back saying which one it is. During an open sitting on
  -- this question's own test or paper that is the answer key, mid-paper. 0018
  -- keeps the key off the phone until submit; this keeps it out of the model
  -- reply too.
  --
  -- `mode = 'exam'` only: practice mode marks every answer as it is tapped,
  -- so there is nothing left to leak and Revision stays open.
  if exists (
    select 1
    from public.attempts a
    where a.user_id = caller
      and a.mode = 'exam'
      and a.submitted_at is null
      and (a.deadline_at is null or now() < a.deadline_at)
      and (
        (qtest is not null and a.test_id = qtest)
        or (qpaper is not null and a.paper_id = qpaper)
      )
  ) then
    return 'not_found';
  end if;

  -- The free, unlimited path. Checked BEFORE the counter, which is the whole
  -- point of saving explanations. `coalesce(claimed_at, created_at)` covers a
  -- row written before this migration: it has no claimant, so it is treated
  -- as claimed when it was created and becomes takeable like any other.
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

  -- THE RACE, now with a third door. The primary key lets exactly one insert
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
  'One transaction: plan gate, question visibility, mock paywall, open-exam refusal, saved lookup, 30-a-day check, and the insert whose primary key decides who calls the model. Stamps claimed_by/claimed_at, and takes over a claim older than ai_claim_timeout() with a one-time refund. Returns no_plan | not_found | ready | generating | limit | claimed. Issues 22-revision-api, 32-ai-claim-tokens.';

grant execute on function public.claim_ai_explanation(uuid, text) to authenticated;

-- --------------------------------------------------------------------------
-- finish_ai_explanation: the claimant, and nobody else
-- --------------------------------------------------------------------------
--
-- `claimed_by = auth.uid()` is the whole fix for the poisoning hole. A row
-- with no claimant (written before this migration, or whose account was
-- deleted) can never be finished, which is right: nobody is in flight, so
-- there is no reply to save. The next reader re-claims it as a stale row.
--
-- NOTHING IS REFUNDED HERE, in any branch. A finished call was made and
-- billed. This is the other half of the cost hole: a refund may only ever
-- come from a failure before there was any text.
create or replace function public.finish_ai_explanation(
  question_id uuid,
  lang        text,
  body        jsonb,
  sources     jsonb,
  model       text,
  tokens_in   integer,
  tokens_out  integer,
  searches    integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid    uuid := finish_ai_explanation.question_id;
  qlang  text := finish_ai_explanation.lang;
  jbody  jsonb := finish_ai_explanation.body;
  jsrc   jsonb := finish_ai_explanation.sources;
  mdl    text := finish_ai_explanation.model;
  tin    integer := finish_ai_explanation.tokens_in;
  tout   integer := finish_ai_explanation.tokens_out;
  nsrch  integer := finish_ai_explanation.searches;
  caller uuid := auth.uid();
  clean  jsonb;
  saved  integer;
begin
  if caller is null then
    return false;
  end if;

  -- Normalise the sources instead of refusing the whole reply: the
  -- explanation a student paid for is still useful without one bad link, and
  -- the CHECK above would otherwise turn a stray `javascript:` into a lost
  -- call. A non-array `sources` is an empty list, not an error.
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
    -- ... and it is YOUR call, so another student cannot write the text every
    -- future student will read.
    and e.claimed_by = caller;

  get diagnostics saved = row_count;
  return saved = 1;
end;
$$;

comment on function public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer) is
  'Save a finished explanation. Only the CLAIMANT, only a generating row, and only http(s) sources are stored. Never refunds. Issues 22-revision-api, 32-ai-claim-tokens.';

grant execute on function
  public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer)
  to authenticated;

-- --------------------------------------------------------------------------
-- fail_ai_explanation: the claimant gets their own call back
-- --------------------------------------------------------------------------
--
-- A student must not lose 1 of 30 because our model call timed out. They also
-- must not be able to hand that refund to themselves for somebody else's
-- call, which is what `auth.uid() is not null` allowed.
--
-- The refund can only happen when this statement moved a row from
-- `generating` to `failed`, which happens at most once per claim, and a
-- `generating` row has no body yet (`finish` is what writes one). So "only
-- when the call failed before any text was produced" holds by construction.
create or replace function public.fail_ai_explanation(question_id uuid, lang text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid     uuid := fail_ai_explanation.question_id;
  qlang   text := fail_ai_explanation.lang;
  caller  uuid := auth.uid();
  charged date;
  moved   integer;
begin
  if caller is null then
    return false;
  end if;

  -- `returning ... into` reads the claim's own moment out of the row it just
  -- moved, in the same statement, so the refund cannot be aimed at the wrong
  -- India day by a clock that rolled over in between.
  update public.ai_explanations e
  set status = 'failed'
  where e.question_id = qid
    and e.lang = qlang
    and e.status = 'generating'
    and e.claimed_by = caller
  returning public.ist_date_of(coalesce(e.claimed_at, e.created_at)) into charged;

  get diagnostics moved = row_count;

  -- Nothing of yours was in flight, so there is nothing to refund. Refunding
  -- anyway would be a free call for anybody who posts this twice, or for
  -- anybody who posts it at all.
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

comment on function public.fail_ai_explanation(uuid, text) is
  'Mark YOUR OWN generating explanation failed and give that 1 of 30 back, in one transaction, on the India day it was charged to. Another student''s claim is refused. Issues 22-revision-api, 32-ai-claim-tokens.';

grant execute on function public.fail_ai_explanation(uuid, text) to authenticated;

-- --------------------------------------------------------------------------
-- claim_explanation_audio: the same owner rule, plus a way out of `making`
-- --------------------------------------------------------------------------
--
-- Unchanged word list: not_found | not_ready | ready | making | claimed.
-- Unchanged plan position too (0025 explains why there is no plan gate: the
-- audio is made at most once per explanation FOREVER, so the voice spend is
-- already bounded by the 30-a-day counter on the text).
--
-- What is new is that a claim is stamped and can time out. Before this, one
-- caller who claimed and never finished left the explanation on `making` for
-- good: silent forever, with no retry and nothing to sweep it.
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
  'One transaction: question visibility, text readiness, and the UPDATE whose row_count decides who calls the voice. Stamps audio_claimed_by/at and takes over a claim older than ai_claim_timeout(). Returns not_found | not_ready | ready | making | claimed. Issues 25-revision-audio, 32-ai-claim-tokens.';

grant execute on function public.claim_explanation_audio(uuid, text) to authenticated;

-- --------------------------------------------------------------------------
-- finish_explanation_audio: the claimant, and its own folder
-- --------------------------------------------------------------------------
--
-- Two new refusals:
--
--  * `audio_claimed_by = auth.uid()`. Otherwise any student could point a
--    popular explanation at any object in the bucket.
--  * the path must sit under `explanations/<question id>/`, which is exactly
--    what `explanationAudioPath()` in `src/lib/ai/audio.ts` builds. A `..`
--    anywhere is refused outright, because Storage resolves a key as text and
--    a prefix test alone would accept `explanations/<id>/../<other>/en.mp3`.
create or replace function public.finish_explanation_audio(
  question_id uuid,
  lang        text,
  audio_path  text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid    uuid := finish_explanation_audio.question_id;
  qlang  text := finish_explanation_audio.lang;
  apath  text := nullif(btrim(finish_explanation_audio.audio_path), '');
  caller uuid := auth.uid();
  folder text;
  saved  integer;
begin
  if caller is null then
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
    and e.audio_claimed_by = caller;

  get diagnostics saved = row_count;
  return saved = 1;
end;
$$;

comment on function public.finish_explanation_audio(uuid, text, text) is
  'Save the Storage path of a finished audio file. Only the CLAIMANT, only a row that is still making, and only a path inside explanations/<question id>/. Issues 25-revision-audio, 32-ai-claim-tokens.';

grant execute on function public.finish_explanation_audio(uuid, text, text) to authenticated;

-- --------------------------------------------------------------------------
-- fail_explanation_audio: the claimant releases their own slot
-- --------------------------------------------------------------------------
--
-- Nothing is refunded (audio is not on the 30-a-day counter), so the only
-- hole here was griefing: anybody could release a voice call that was still
-- running and let a second one be paid for.
create or replace function public.fail_explanation_audio(question_id uuid, lang text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid    uuid := fail_explanation_audio.question_id;
  qlang  text := fail_explanation_audio.lang;
  caller uuid := auth.uid();
  moved  integer;
begin
  if caller is null then
    return false;
  end if;

  update public.ai_explanations e
  set audio_status = 'failed'
  where e.question_id = qid
    and e.lang = qlang
    and e.audio_status = 'making'
    and e.audio_claimed_by = caller;

  get diagnostics moved = row_count;
  return moved = 1;
end;
$$;

comment on function public.fail_explanation_audio(uuid, text) is
  'Release YOUR OWN claimed audio slot so a later read may retry it. Nothing is refunded: audio is not on the 30-a-day counter. Issues 25-revision-audio, 32-ai-claim-tokens.';

grant execute on function public.fail_explanation_audio(uuid, text) to authenticated;

-- --------------------------------------------------------------------------
-- A teacher edit does not inherit a claim
-- --------------------------------------------------------------------------
--
-- 0024's trigger pins everything a correction may not change. The four claim
-- columns are now on that list: an edit that moved `claimed_by` onto the
-- teacher would hand them a claim they never paid for.
--
-- It also fixes a second thing the claim columns made unavoidable. 0024 drops
-- `audio_path` when the body changes (new text, so the old narration is
-- wrong), and 0025 later added `audio_ready_has_path_check`. On a row whose
-- audio was `ready` the two met and the edit FAILED on the constraint. The
-- audio state is now reset with the path, so a corrected explanation simply
-- has its narration made again.
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

  -- A claim belongs to whoever paid for the call (issue 32).
  new.claimed_by := old.claimed_by;
  new.claimed_at := old.claimed_at;

  -- Narration (issue 25) is read aloud from `body`. New text means the old
  -- audio is now wrong, and wrong audio is worse than none, so the whole
  -- audio state goes back to "nobody has made it".
  if new.body is distinct from old.body then
    new.audio_path       := null;
    new.audio_status     := 'none';
    new.audio_claimed_by := null;
    new.audio_claimed_at := null;
  else
    new.audio_path       := old.audio_path;
    new.audio_status     := old.audio_status;
    new.audio_claimed_by := old.audio_claimed_by;
    new.audio_claimed_at := old.audio_claimed_at;
  end if;

  return new;
end;
$$;

comment on function public.ai_explanation_teacher_edit() is
  'Pins everything a teacher edit may not change: the row identity, the ready status, the model and token columns, and the claim. Resets the audio state when the text changes. Issues 24-revision-teacher-edit, 32-ai-claim-tokens.';

-- --------------------------------------------------------------------------
-- RLS
-- --------------------------------------------------------------------------
--
-- Nothing is added and nothing is widened. `ai_explanations` still has NO
-- insert policy and no student update policy, so all four claim columns can
-- only ever move inside the functions above. That is what makes the owner
-- check meaningful: a student cannot write `claimed_by = me` and then finish.
