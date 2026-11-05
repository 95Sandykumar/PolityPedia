-- 0025_revision_audio.sql  (issue 25-revision-audio)
--
-- Audio for a saved explanation: made ONCE, saved, reused by every student.
--
-- F-F5: "a paid AI voice, Hindi and English, made once and saved". A paid
-- voice is charged per character, so the rule is the same one 0022 keeps for
-- the model call, and it has to be kept the same way: inside Postgres.
--
-- 0022 used the primary key of `ai_explanations` to decide who calls the
-- model. The row already exists by the time there is anything to read out, so
-- an insert cannot decide this race. An UPDATE does: it only matches a row
-- whose audio nobody has claimed, and `row_count` says who won. One
-- statement, one transaction, no lock, nothing that dies with a serverless
-- process.
--
-- `audio_path` itself was added by 0022 and left null on purpose. This file
-- adds the one column that was missing: the state of the audio, so "nobody
-- has started" and "somebody is making it right now" are not the same thing.

-- --------------------------------------------------------------------------
-- audio_status: the state of the audio for one (question, language)
-- --------------------------------------------------------------------------
--
--   none    -> no audio and nobody is making it. Claimable.
--   making  -> a voice call is in flight. NOT claimable.
--   ready   -> the file is in Storage and `audio_path` points at it.
--   failed  -> the call broke. Claimable again, so a retry is possible.
alter table public.ai_explanations
  add column if not exists audio_status text not null default 'none';

comment on column public.ai_explanations.audio_status is
  'none = claimable, making = a voice call is in flight, ready = audio_path is playable, failed = claimable again. Issue 25-revision-audio.';

alter table public.ai_explanations
  drop constraint if exists ai_explanations_audio_status_check;
alter table public.ai_explanations
  add constraint ai_explanations_audio_status_check
    check (audio_status in ('none', 'making', 'ready', 'failed'));

-- The same guard `ai_explanations_ready_has_body_check` gives the text: a
-- `ready` audio HAS a file. Without this, a half-finished write could leave a
-- row the UI draws a player for and the player has nothing to fetch.
alter table public.ai_explanations
  drop constraint if exists ai_explanations_audio_ready_has_path_check;
alter table public.ai_explanations
  add constraint ai_explanations_audio_ready_has_path_check
    check (audio_status <> 'ready' or audio_path is not null);

-- --------------------------------------------------------------------------
-- claim_explanation_audio: who makes the audio
-- --------------------------------------------------------------------------
--
-- Returns one word, and the caller does exactly what it says:
--
--   not_found  -> no such explanation, or the question is not readable.
--   not_ready  -> the TEXT is still being written. Nothing to read out yet.
--   ready      -> the audio is already saved. Do nothing; it costs nothing.
--   making     -> somebody else's voice call is in flight. Do nothing.
--   claimed    -> YOU call the voice, then finish_explanation_audio().
--
-- SECURITY DEFINER for the same reason as `claim_ai_explanation`: a student
-- may not write `ai_explanations` directly (there is no insert or student
-- update policy), so the state move has to happen inside a function whose
-- `search_path` is pinned.
--
-- NO PLAN GATE HERE, on purpose. The explanation this audio reads out was
-- already paid for by whoever asked for it, and the audio is made at most
-- once per (question, language) FOREVER. So the total voice spend is bounded
-- by the number of explanations, which the 30-a-day counter in 0022 already
-- bounds. Adding a plan check would only mean a free student reading a saved
-- explanation leaves the audio unmade for the next paying one.
--
-- plpgsql, not sql, so the parameters can be qualified: their names match the
-- COLUMN names, and a bare `lang` in the body would resolve to the column.
create or replace function public.claim_explanation_audio(question_id uuid, lang text)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid     uuid := claim_explanation_audio.question_id;
  qlang   text := claim_explanation_audio.lang;
  caller  uuid := auth.uid();
  state   text;
  astate  text;
  apath   text;
  owner   uuid;
  live    boolean;
  taken   integer;
begin
  if caller is null then
    return 'not_found';
  end if;

  select e.status, e.audio_status, e.audio_path
  into state, astate, apath
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
  if astate = 'making' then
    return 'making';
  end if;

  -- THE RACE. Two students opened the same explanation at the same instant,
  -- both read `none` above. This UPDATE matches at most one of them, because
  -- the first one to commit leaves `audio_status = 'making'` behind.
  update public.ai_explanations e
  set audio_status = 'making'
  where e.question_id = qid
    and e.lang = qlang
    and e.status = 'ready'
    and e.audio_path is null
    and e.audio_status in ('none', 'failed');

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
  'One transaction: question visibility, text readiness, and the UPDATE whose row_count decides who calls the voice. Returns not_found | not_ready | ready | making | claimed. Issue 25-revision-audio.';

grant execute on function public.claim_explanation_audio(uuid, text) to authenticated;

-- --------------------------------------------------------------------------
-- finish_explanation_audio: save the file path
-- --------------------------------------------------------------------------
--
-- Only moves a row that is still `making`, so a late reply from a retried
-- call cannot point a second object at the same explanation.
--
-- An empty path is refused rather than stored: the `ready` state promises a
-- playable file, and a blank path would be a player that 404s.
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
  saved  integer;
begin
  if auth.uid() is null then
    return false;
  end if;
  if apath is null then
    return false;
  end if;

  update public.ai_explanations e
  set audio_path   = apath,
      audio_status = 'ready'
  where e.question_id = qid
    and e.lang = qlang
    and e.audio_status = 'making';

  get diagnostics saved = row_count;
  return saved = 1;
end;
$$;

comment on function public.finish_explanation_audio(uuid, text, text) is
  'Save the Storage path of a finished audio file. Only touches a row that is still making, so one explanation never gets two objects. Issue 25-revision-audio.';

grant execute on function public.finish_explanation_audio(uuid, text, text) to authenticated;

-- --------------------------------------------------------------------------
-- fail_explanation_audio: release the row for a retry
-- --------------------------------------------------------------------------
--
-- Nothing is refunded here, unlike `fail_ai_explanation`: audio does not come
-- out of the student's 30 a day. All this does is stop one broken voice call
-- from leaving an explanation permanently silent.
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
  moved  integer;
begin
  if auth.uid() is null then
    return false;
  end if;

  update public.ai_explanations e
  set audio_status = 'failed'
  where e.question_id = qid
    and e.lang = qlang
    and e.audio_status = 'making';

  get diagnostics moved = row_count;
  return moved = 1;
end;
$$;

comment on function public.fail_explanation_audio(uuid, text) is
  'Release a claimed audio slot so a later read may retry it. Nothing is refunded: audio is not on the 30-a-day counter. Issue 25-revision-audio.';

grant execute on function public.fail_explanation_audio(uuid, text) to authenticated;

-- --------------------------------------------------------------------------
-- RLS
-- --------------------------------------------------------------------------
--
-- Nothing is added. `ai_explanations` already has RLS on from 0022, with a
-- select policy keyed on question visibility and an update policy for the
-- question's own teacher. There is still NO student update policy, so
-- `audio_path` and `audio_status` can only ever move through the three
-- functions above. That is what keeps "made once" true even if a route
-- handler is wrong.
--
-- The audio objects live in a PRIVATE Storage bucket, like the papers one.
-- Buckets and their storage policies are created in the Supabase dashboard,
-- not here: these migrations never touch the `storage` schema (see the note
-- at the top of 0010_papers.sql). A student never gets a bucket URL; they get
-- a short-lived signed one from GET /api/revision/audio.
