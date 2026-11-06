-- 0040_ai_finish_server_only.sql  (issue 41-ai-finish-server-only)
--
-- ONLY THE SERVER MAY FINISH OR FAIL A CLAIM.
--
-- 0038 gave a claim a one-time SECRET and made `finish_*` and `fail_*` need
-- it. That closed the replay it was written for. It left the door itself
-- open, because all four functions were still:
--
--     grant execute on function ... to authenticated;
--
-- and `claim_ai_explanation` hands the CLAIMANT their own secret. So a student
-- on the AI plan could do the whole thing from the browser, over REST, with
-- the key that is printed in our own HTML:
--
--   1. post `rpc/claim_ai_explanation`. The reply contains a genuine secret:
--      they are the call that created the claim, so they are told it.
--   2. post `rpc/finish_ai_explanation` with that secret and any body and
--      sources they wrote themselves.
--   3. the row is `ready`. From then on EVERY student who opens that question
--      reads the attacker's text, with our teacher's name above it. It cost
--      them 1 of their 30.
--
-- `fail_ai_explanation` is the same shape against the 30-a-day cap, and the
-- two audio functions are the same shape against the paid voice: release a
-- voice call that is still running and the next read starts (and bills) a
-- second one.
--
-- The secret was never going to fix this on its own. A secret proves "you are
-- the call that holds the claim"; it cannot prove "you are our server", and
-- that second sentence is the one that has to be true before text is saved
-- for every future reader.
--
-- THE FIX, now that there IS a server-only key (H1: the real Supabase project
-- exists, and `src/lib/purchases/supabase-webhook-store.ts` already carries
-- `SUPABASE_SERVICE_ROLE_KEY` for the Razorpay webhook):
--
--   a. EXECUTE on the four functions is revoked from `public`, `anon` and
--      `authenticated`, and granted to `service_role` alone. A browser now
--      gets a permission error, not a `false`. This is the same shape as
--      `grant_purchase()` in 0027: a function that moves money or writes what
--      everybody reads is not reachable with a student's key.
--
--   b. a service-role token has NO `sub` claim, so `auth.uid()` is NULL
--      inside these calls. All four therefore stop reading it. They find
--      their row by `(question_id, lang)` AND THE SECRET, and the refund in
--      `fail_ai_explanation` goes to the `claimed_by` STORED ON THE ROW.
--
-- The secret is now the whole proof of identity, which is why it is REQUIRED
-- (NULL is refused before any read) and why it is CLEARED on every success,
-- finish as well as fail. 0038 only cleared it on fail; a finished row was
-- safe by its `status = 'generating'` test alone. Clearing it on both is one
-- rule instead of two, and it leaves no live hash on a row whose call is
-- over.
--
-- WHAT IS NOT TOUCHED.
--
--   * `claim_ai_explanation` and `claim_explanation_audio` STAY on
--     `authenticated`, unchanged. The plan gate (F-F6), the mock paywall, the
--     open-exam refusal (0036, 0037) and the 30-a-day counter (X6) all read
--     `auth.uid()`, and they must keep reading the STUDENT'S own. The claim is
--     where a student spends their own quota, so the claim is the one call
--     that belongs to the student's token.
--   * every other rule from 0037 and 0038: the `for update` read that makes a
--     takeover refund exactly once, a takeover killing the previous secret,
--     the `explanations/<question id>/` path rule, the http(s) source filter,
--     "a finished call is never refunded", and the teacher-edit trigger's
--     pinned columns.
--   * the exam locks (0030, 0036, 0037), the webhooks, and sessions.
--
-- THE KEY ITSELF. `SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy. It
-- has no `NEXT_PUBLIC_` prefix, so Next.js cannot inline it into a browser
-- bundle, it is read lazily inside a function (web/CLAUDE.md), and it is
-- never logged. See `src/lib/ai/service-env.ts`.

-- ---------------------------------------------------------------------------
-- 1. finish_ai_explanation: the server, holding the claim's secret
-- ---------------------------------------------------------------------------
--
-- Same signature as 0038, so `create or replace` is enough and no REST caller
-- has to change its request body. `claim_secret` keeps its NULL default, so a
-- pre-37 eight-argument body still resolves here and is still refused rather
-- than erroring.
--
-- `auth.uid()` is gone, and with it the `claimed_by = caller` test. The
-- secret replaces it: 122 random bits from the server's CSPRNG, stored only
-- as a sha256, and told to exactly one call. `search_path` drops `auth`
-- because nothing in here reads that schema any more.
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
set search_path = public, pg_temp
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
  clean   jsonb;
  saved   integer;
begin
  -- NO SECRET, NO SAVE, and no error either: a refusal that threw would tell
  -- a caller something, and `false` is all any caller needs. The UPDATE below
  -- would refuse a NULL anyway (`ai_claim_secret_hash(null)` is NULL, and
  -- `hash = null` is never true); saying it here is what makes the rule
  -- readable.
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
      searches   = nsrch,
      -- Single use (issue 41). The call is over, so its secret is dead, and
      -- `claimed_by` is left alone: the claim still names who paid for it.
      claim_secret_hash = null
  where e.question_id = qid
    and e.lang = qlang
    -- Still in flight, so a late reply cannot overwrite a teacher's
    -- correction (0024) or a newer claimant's finished text ...
    and e.status = 'generating'
    -- ... and this IS the call that holds the claim (issues 37 and 41). The
    -- hash is the only identity test left, because a service-role call has no
    -- `auth.uid()` to compare `claimed_by` against. A takeover replaced this
    -- hash, so the previous claimant's late reply lands here and matches
    -- nothing.
    and e.claim_secret_hash is not null
    and e.claim_secret_hash = public.ai_claim_secret_hash(csecret);

  get diagnostics saved = row_count;
  return saved = 1;
end;
$$;

comment on function public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer, uuid) is
  'Save a finished explanation. SERVICE ROLE ONLY (issue 41): a student''s key cannot reach it, so nobody can write the text every future student reads. Finds the row by (question_id, lang) and the one-time secret claim_ai_explanation() returned, never by auth.uid(), because a service-role call has none. Only a generating row and only http(s) sources are stored, the secret is cleared on success, and nothing is ever refunded. A NULL or wrong secret returns false. Issues 22-revision-api, 32-ai-claim-tokens, 37-ai-claim-secret, 41-ai-finish-server-only.';

-- ---------------------------------------------------------------------------
-- 2. fail_ai_explanation: the refund goes to whoever is on the row
-- ---------------------------------------------------------------------------
--
-- The only function here that moves a number a student can spend, so it is
-- the one that had to stop trusting the caller's own identity.
--
-- `returning ... into` reads BOTH the claimant and the claim's own moment out
-- of the row it just moved, in the same statement. That is what makes the
-- refund right without `auth.uid()`: the user id comes from the row, so it is
-- whoever actually paid, and the India day comes from `claimed_at`, so a
-- clock that rolled over in between cannot aim the refund at the wrong day.
--
-- The refund can only happen when this statement moved a row from
-- `generating` to `failed`, which happens at most once per claim, and a
-- `generating` row has no body yet. So "only when the call failed before any
-- text was produced", and "never twice", both hold by construction.
create or replace function public.fail_ai_explanation(
  question_id  uuid,
  lang         text,
  claim_secret uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  qid     uuid := fail_ai_explanation.question_id;
  qlang   text := fail_ai_explanation.lang;
  csecret uuid := fail_ai_explanation.claim_secret;
  -- The student to pay back, read off the row, not off the token.
  owed    uuid;
  charged date;
  moved   integer;
begin
  -- NO SECRET, NO REFUND.
  if csecret is null then
    return false;
  end if;

  update public.ai_explanations e
  set status            = 'failed',
      -- Single use. Nothing can replay this secret, on this row, ever.
      claim_secret_hash = null
  where e.question_id = qid
    and e.lang = qlang
    and e.status = 'generating'
    and e.claim_secret_hash is not null
    and e.claim_secret_hash = public.ai_claim_secret_hash(csecret)
  returning e.claimed_by,
            public.ist_date_of(coalesce(e.claimed_at, e.created_at))
  into owed, charged;

  get diagnostics moved = row_count;

  -- No row was in flight under this secret, so there is nothing to refund.
  -- Refunding anyway is the free call this chain of issues is closing.
  if moved = 0 then
    return false;
  end if;

  -- A row written before 0032 has no claimant. The release above still
  -- happened, so the answer is TRUE; there is simply nobody to pay back.
  if owed is not null then
    update public.ai_usage u
    set new_count = greatest(u.new_count - 1, 0)
    where u.user_id = owed
      and u.ist_date = coalesce(charged, public.ist_today());
  end if;

  return true;
end;
$$;

comment on function public.fail_ai_explanation(uuid, text, uuid) is
  'Mark a generating explanation failed and give that 1 of 30 back, in one transaction. SERVICE ROLE ONLY (issue 41): the claimant''s own browser cannot refund a call our server is still making, which is what kept the 30-a-day cap at 0. The claim is found by (question_id, lang) and the one-time secret, and the refund goes to the claimed_by on the row, on the India day it was charged, never to auth.uid(). The secret is cleared on success, so a second call refunds nothing. A NULL or wrong secret returns false. Issues 22-revision-api, 32-ai-claim-tokens, 37-ai-claim-secret, 41-ai-finish-server-only.';

-- ---------------------------------------------------------------------------
-- 3. finish_explanation_audio: the same three path rules, minus auth.uid()
-- ---------------------------------------------------------------------------
--
-- The path rules are KEPT, and they matter more now, not less: the caller is
-- a role that bypasses RLS, so "inside `explanations/<question id>/` with no
-- `..`" is the only thing standing between a bug in our own audio step and a
-- row pointing at somebody's paper PDF.
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
set search_path = public, pg_temp
as $$
declare
  qid     uuid := finish_explanation_audio.question_id;
  qlang   text := finish_explanation_audio.lang;
  apath   text := nullif(btrim(finish_explanation_audio.audio_path), '');
  csecret uuid := finish_explanation_audio.claim_secret;
  folder  text;
  saved   integer;
begin
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
      audio_status = 'ready',
      -- Single use (issue 41), the same as the text claim.
      audio_claim_secret_hash = null
  where e.question_id = qid
    and e.lang = qlang
    and e.audio_status = 'making'
    and e.audio_claim_secret_hash is not null
    and e.audio_claim_secret_hash = public.ai_claim_secret_hash(csecret);

  get diagnostics saved = row_count;
  return saved = 1;
end;
$$;

comment on function public.finish_explanation_audio(uuid, text, text, uuid) is
  'Save the Storage path of a finished audio file. SERVICE ROLE ONLY (issue 41). Finds the row by (question_id, lang) and the one-time secret claim_explanation_audio() returned, never by auth.uid(). Only a row that is still making, and only a path inside explanations/<question id>/ with no .. in it. The secret is cleared on success. Issues 25-revision-audio, 32-ai-claim-tokens, 37-ai-claim-secret, 41-ai-finish-server-only.';

-- ---------------------------------------------------------------------------
-- 4. fail_explanation_audio: releasing a voice call is a server decision
-- ---------------------------------------------------------------------------
--
-- Nothing is refunded (audio is not on the 30-a-day counter), so the hole
-- here was never a free call, it was a PAID one: release a voice call that is
-- still running and the next read starts a second one for the same words,
-- billed per character.
create or replace function public.fail_explanation_audio(
  question_id  uuid,
  lang         text,
  claim_secret uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  qid     uuid := fail_explanation_audio.question_id;
  qlang   text := fail_explanation_audio.lang;
  csecret uuid := fail_explanation_audio.claim_secret;
  moved   integer;
begin
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
    and e.audio_claim_secret_hash is not null
    and e.audio_claim_secret_hash = public.ai_claim_secret_hash(csecret);

  get diagnostics moved = row_count;
  return moved = 1;
end;
$$;

comment on function public.fail_explanation_audio(uuid, text, uuid) is
  'Release a claimed audio slot so a later read may retry it. SERVICE ROLE ONLY (issue 41): a student''s browser cannot cancel a voice call that is still running and make us pay for a second one. Found by (question_id, lang) and the one-time secret, never by auth.uid(). Nothing is refunded: audio is not on the 30-a-day counter. Issues 25-revision-audio, 32-ai-claim-tokens, 37-ai-claim-secret, 41-ai-finish-server-only.';

-- ---------------------------------------------------------------------------
-- 5. THE GRANT. This block is the issue.
-- ---------------------------------------------------------------------------
--
-- Spelled out for all three client roles, in this order, because
-- `create or replace` above KEPT the ACL each function already had (0038
-- granted all four to `authenticated`), and because Supabase's default
-- privileges hand EXECUTE on a new public function to `anon` and
-- `authenticated` anyway. A revoke that is not written down does not happen.
--
--   * `public` is the pseudo-role "everybody", including future roles.
--   * `anon` is an unauthenticated REST caller.
--   * `authenticated` is a signed-in student's own browser. THIS is the one
--     the issue is about.
revoke all on function
  public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_ai_explanation(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.finish_explanation_audio(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_explanation_audio(uuid, text, uuid)
  from public, anon, authenticated;

-- `service_role` is granted INSIDE a guard, the same way 0027, 0028 and 0029
-- do it: the role is created by the Supabase platform, so a bare grant would
-- make these migrations unrunnable anywhere that platform is not. The test
-- harness creates it (`web/test/db.ts`), precisely so this grant is covered.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.finish_ai_explanation('
            || 'uuid, text, jsonb, jsonb, text, integer, integer, integer, uuid'
            || ') to service_role';
    execute 'grant execute on function public.fail_ai_explanation(uuid, text, uuid) to service_role';
    execute 'grant execute on function public.finish_explanation_audio(uuid, text, text, uuid) to service_role';
    execute 'grant execute on function public.fail_explanation_audio(uuid, text, uuid) to service_role';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The two CLAIM functions are deliberately left alone
-- ---------------------------------------------------------------------------
--
-- No revoke, no replace. `claim_ai_explanation` and `claim_explanation_audio`
-- stay exactly as 0038 left them, granted to `authenticated`, because every
-- gate inside them is about the person asking: the AI plan (F-F6), the mock
-- paywall, the open-exam refusal (F-E5), and the 30-a-day cap (X6). Moving
-- them to `service_role` would mean passing a user id in from our server as
-- an argument, and an argument is something a route handler can get wrong.
-- `auth.uid()` cannot be got wrong.
--
-- A browser can therefore still post `rpc/claim_ai_explanation` and still be
-- handed a secret. It buys nothing now: the claim leaves the row on
-- `generating`, no model is called, and the only two functions that could
-- turn that claim into saved text or a refund are out of reach. The claim
-- times out after `ai_claim_timeout()` and the next reader takes it over,
-- which refunds the 1 of 30 that the attempt cost.

-- ---------------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------------
--
-- Nothing is added and nothing is widened. `ai_explanations` still has NO
-- insert policy and no student update policy, so every claim column and both
-- hash columns can still only move inside the functions above. `service_role`
-- bypasses RLS by definition, which is exactly why its key stays on the
-- server and why only these four functions are reachable with it.
