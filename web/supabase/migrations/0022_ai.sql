-- 0022_ai.sql  (issue 22-revision-api)
--
-- Saved AI explanations plus the daily counter behind "Revision (AI)".
--
-- The one promise this file has to keep (F-F4): ONE AI call per question and
-- language, ever. A saved explanation is free and unlimited; only a NEW one
-- costs a student 1 of their 30 for the India day.
--
-- Two students tapping Revision at the same instant must not both pay for a
-- call. The primary key of `ai_explanations` decides that race inside
-- Postgres: the first `insert` wins and gets told to call the model, the
-- second one inserts nothing and is told the answer is already being written.
-- No lock, no queue, no application-side mutex that dies with the process.

-- --------------------------------------------------------------------------
-- ai_explanations: one saved explanation per (question, language)
-- --------------------------------------------------------------------------
create table if not exists public.ai_explanations (
  question_id       uuid        not null
    references public.questions (id) on delete cascade,
  lang              text        not null,
  status            text        not null default 'generating',
  -- The structured output from the model: exam, topic, question, sections[],
  -- remember. jsonb, not text, so a later slice can render sections without
  -- parsing prose back out.
  body              jsonb,
  -- [{title, url}]. Kept apart from `body` because the audio slice (25) reads
  -- `body` only, and the UI shows sources as links under it.
  sources           jsonb,
  -- Filled by issue 25 (TTS). Null here on purpose: no audio in this slice.
  audio_path        text,
  -- A teacher corrected the AI text. The UI must then stop calling it "AI".
  edited_by_teacher boolean     not null default false,
  -- Cost and provenance, for the live cost check (AS3, ticket H3).
  model             text,
  tokens_in         integer,
  tokens_out        integer,
  searches          integer,
  created_at        timestamptz not null default now(),

  primary key (question_id, lang),

  constraint ai_explanations_status_check
    check (status in ('generating', 'ready', 'failed')),
  -- Same two languages a question can be written in (0011).
  constraint ai_explanations_lang_check check (lang in ('en', 'hi')),

  -- A ready explanation HAS a body. Without this a failed write could leave a
  -- row that the app shows as an empty explanation and never regenerates.
  constraint ai_explanations_ready_has_body_check
    check (status <> 'ready' or body is not null),

  constraint ai_explanations_tokens_check
    check (coalesce(tokens_in, 0) >= 0 and coalesce(tokens_out, 0) >= 0),
  -- F4: at most 2 web searches per call, so a stored count above 2 is a bug.
  constraint ai_explanations_searches_check
    check (searches is null or searches between 0 and 2)
);

comment on table public.ai_explanations is
  'One AI explanation per (question, language). The primary key is the race winner, so a question is explained once. Issue 22-revision-api.';
comment on column public.ai_explanations.status is
  'generating = a call is in flight, ready = saved and free to read, failed = the call broke and may be retried.';
comment on column public.ai_explanations.edited_by_teacher is
  'A teacher corrected the text. The UI must not label an edited explanation as AI-written.';

-- --------------------------------------------------------------------------
-- ai_usage: 30 NEW explanations per student per India day
-- --------------------------------------------------------------------------
--
-- The day is the INDIA day, not UTC. A student in Delhi revising at 02:00 is
-- on a new day; a UTC counter would still be on yesterday's and would give
-- them 30 more at 05:30 instead of midnight.
create table if not exists public.ai_usage (
  user_id   uuid    not null references auth.users (id) on delete cascade,
  ist_date  date    not null,
  new_count integer not null default 0,

  primary key (user_id, ist_date),

  -- The refund path (`fail_ai_explanation`) subtracts 1. This makes a double
  -- refund an error instead of a negative balance that hands out free calls.
  constraint ai_usage_new_count_check check (new_count >= 0)
);

comment on table public.ai_usage is
  'How many NEW AI explanations a student has had on one India day. X6: 30 for the AI plan AND for Pro. Issue 22-revision-api.';
comment on column public.ai_usage.ist_date is
  'The India date (Asia/Kolkata) the calls were made on, from public.ist_today().';

-- --------------------------------------------------------------------------
-- The India day
-- --------------------------------------------------------------------------
--
-- One place that answers "what day is it for a student". Every counter read
-- and write goes through it, so the cap can never reset at two moments.
create or replace function public.ist_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

comment on function public.ist_today() is
  'Today in India (Asia/Kolkata). The reset moment for the 30-a-day AI cap. Issue 22-revision-api.';

grant execute on function public.ist_today() to authenticated;

-- X6 (locked): the cap is the same on the AI plan and on Pro.
create or replace function public.ai_daily_cap()
returns integer
language sql
immutable
as $$
  select 30
$$;

comment on function public.ai_daily_cap() is
  'New AI explanations a student may ask for in one India day. Same for AI plan and Pro (X6). Issue 22-revision-api.';

grant execute on function public.ai_daily_cap() to authenticated;

-- --------------------------------------------------------------------------
-- claim_ai_explanation: the whole decision, in one transaction
-- --------------------------------------------------------------------------
--
-- Returns one word, and the caller does exactly what it says:
--
--   no_plan     -> refuse. Show the Rs 100 card.
--   not_found   -> refuse. The question is not live and not the caller's.
--   ready       -> read the saved row. Costs nothing, counts nothing.
--   generating  -> somebody else is writing it. Costs nothing, counts nothing.
--   limit       -> refuse. 30 new ones used today; saved ones still work.
--   claimed     -> YOU call the model, then finish_ai_explanation().
--
-- SECURITY DEFINER because a student may not write `ai_usage` or
-- `ai_explanations` directly: if they could, they could reset their own
-- counter. Every branch below is keyed on auth.uid(), so a caller can only
-- ever claim for themselves, and `search_path` is pinned so the definer
-- rights cannot be aimed at a shadowed table.
--
-- A function body is ONE transaction. So the limit check, the insert that
-- decides the race and the increment either all happen or none do. That is
-- what stops a crash in the middle from charging a student for a call that
-- was never made.
--
-- plpgsql, not sql, so the parameters can be qualified
-- (`claim_ai_explanation.question_id`). In a LANGUAGE SQL body a bare
-- `question_id` would silently resolve to the COLUMN.
create or replace function public.claim_ai_explanation(question_id uuid, lang text)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  -- The parameters are copied into locals on purpose. Their names match the
  -- COLUMN names, and inside an `insert ... on conflict (question_id, lang)`
  -- plpgsql cannot tell the two apart ("column reference is ambiguous").
  -- The parameter names stay as they are because they are the wire contract:
  -- Supabase RPC posts {"question_id": ..., "lang": ...}.
  qid      uuid := claim_ai_explanation.question_id;
  qlang    text := claim_ai_explanation.lang;
  caller   uuid := auth.uid();
  today    date := public.ist_today();
  owner    uuid;
  live     boolean;
  found    text;
  used     integer;
  claimed  integer;
begin
  if caller is null then
    return 'no_plan';
  end if;

  -- F-F6: the AI plan or Pro. `can_use` is SECURITY INVOKER, but this
  -- function is a definer, so the read inside it is not filtered by the
  -- caller's own entitlements policy. Passing `caller` keeps it honest: the
  -- answer is about the signed-in user and nobody else.
  if not public.can_use(caller, 'ai') then
    return 'no_plan';
  end if;

  -- RLS is off inside a definer, so the visibility rule is spelled out here:
  -- a live question (any student) or the caller's own draft (its teacher).
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

  -- The free, unlimited path. Checked BEFORE the counter, which is the whole
  -- point of saving explanations.
  select e.status into found
  from public.ai_explanations e
  where e.question_id = qid
    and e.lang = qlang;

  if found = 'ready' then
    return 'ready';
  end if;
  if found = 'generating' then
    return 'generating';
  end if;

  -- Only a NEW explanation is counted, so the check sits here and nowhere
  -- earlier. A student at their cap can still read every saved one.
  select coalesce(u.new_count, 0) into used
  from public.ai_usage u
  where u.user_id = caller and u.ist_date = today;

  if coalesce(used, 0) >= public.ai_daily_cap() then
    return 'limit';
  end if;

  -- THE RACE. Two students arrive together: both reached this line, both saw
  -- no row. The primary key lets exactly one insert through. The `where` on
  -- the conflict branch means a `failed` row may be retried, while a
  -- `generating` or `ready` one that appeared in the last microsecond is left
  -- alone and reported below.
  --
  -- `on constraint`, not `(question_id, lang)`: a bare column list in the
  -- conflict target is read as plpgsql identifiers first, and this function
  -- has parameters with those exact names, so Postgres refuses it as
  -- ambiguous. Naming the primary key leaves no identifier to resolve.
  insert into public.ai_explanations (question_id, lang, status)
  values (qid, qlang, 'generating')
  on conflict on constraint ai_explanations_pkey do update
    set status    = 'generating',
        body      = null,
        sources   = null,
        model     = null,
        tokens_in = null,
        tokens_out = null,
        searches  = null
    where public.ai_explanations.status = 'failed';

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
  'One transaction: plan gate, saved lookup, 30-a-day check, and the insert whose primary key decides who calls the model. Returns no_plan | not_found | ready | generating | limit | claimed. Issue 22-revision-api.';

grant execute on function public.claim_ai_explanation(uuid, text) to authenticated;

-- --------------------------------------------------------------------------
-- finish_ai_explanation: save the answer
-- --------------------------------------------------------------------------
--
-- Only moves a row that is still `generating`, so a late reply from a retried
-- call cannot overwrite an explanation a teacher has since corrected.
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
  -- Same reason as in claim_ai_explanation: the parameter names match the
  -- column names, so every statement below uses a local copy.
  qid    uuid := finish_ai_explanation.question_id;
  qlang  text := finish_ai_explanation.lang;
  jbody  jsonb := finish_ai_explanation.body;
  jsrc   jsonb := finish_ai_explanation.sources;
  mdl    text := finish_ai_explanation.model;
  tin    integer := finish_ai_explanation.tokens_in;
  tout   integer := finish_ai_explanation.tokens_out;
  nsrch  integer := finish_ai_explanation.searches;
  saved  integer;
begin
  if auth.uid() is null then
    return false;
  end if;

  update public.ai_explanations e
  set status     = 'ready',
      body       = jbody,
      sources    = coalesce(jsrc, '[]'::jsonb),
      model      = mdl,
      tokens_in  = tin,
      tokens_out = tout,
      searches   = nsrch
  where e.question_id = qid
    and e.lang = qlang
    and e.status = 'generating';

  get diagnostics saved = row_count;
  return saved = 1;
end;
$$;

comment on function public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer) is
  'Save a finished explanation. Only touches a generating row, so a teacher edit is never overwritten. Issue 22-revision-api.';

grant execute on function
  public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer)
  to authenticated;

-- --------------------------------------------------------------------------
-- fail_ai_explanation: mark it failed and give the call back
-- --------------------------------------------------------------------------
--
-- A student must not lose 1 of 30 because our model call timed out. The
-- refund and the status move are one transaction, so the count can never go
-- down without the row being released for a retry.
--
-- `greatest(... - 1, 0)` on top of the `new_count >= 0` constraint: the
-- constraint catches a bug in a new caller, this keeps an already-zero
-- counter from throwing in the error path, where throwing would hide the real
-- failure from the student.
create or replace function public.fail_ai_explanation(question_id uuid, lang text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  qid    uuid := fail_ai_explanation.question_id;
  qlang  text := fail_ai_explanation.lang;
  caller uuid := auth.uid();
  today  date := public.ist_today();
  moved  integer;
begin
  if caller is null then
    return false;
  end if;

  update public.ai_explanations e
  set status = 'failed'
  where e.question_id = qid
    and e.lang = qlang
    and e.status = 'generating';

  get diagnostics moved = row_count;

  -- Nothing was in flight, so there is nothing to refund. Refunding anyway
  -- would be a free call for anybody who posts this twice.
  if moved = 0 then
    return false;
  end if;

  update public.ai_usage u
  set new_count = greatest(u.new_count - 1, 0)
  where u.user_id = caller and u.ist_date = today;

  return true;
end;
$$;

comment on function public.fail_ai_explanation(uuid, text) is
  'Mark a generating explanation failed and give the student their 1 of 30 back, in one transaction. Issue 22-revision-api.';

grant execute on function public.fail_ai_explanation(uuid, text) to authenticated;

-- --------------------------------------------------------------------------
-- RLS
-- --------------------------------------------------------------------------
alter table public.ai_explanations enable row level security;

-- Read an explanation exactly when you can read its question.
--
-- The subquery runs as the CALLER, so `public.questions`' own policies filter
-- it: a student sees live questions only, a teacher sees their own drafts too.
-- There is no second copy of the visibility rule to drift.
--
-- The PLAN gate is deliberately NOT here. A teacher checking the explanation
-- on their own question has no student plan, and `claim_ai_explanation` plus
-- the route already refuse a new call without one. This policy answers
-- "may you see this text", not "may you buy a new one".
create policy ai_explanations_select_visible on public.ai_explanations
  for select to authenticated
  using (
    exists (
      select 1
      from public.questions q
      where q.id = ai_explanations.question_id
    )
  );

-- A teacher may correct the text on their OWN question (F-F7). Students and
-- other teachers cannot, and nobody can change `question_id` or `lang`,
-- because `with check` re-tests ownership on the new row.
create policy ai_explanations_update_owner on public.ai_explanations
  for update to authenticated
  using (
    exists (
      select 1
      from public.questions q
      where q.id = ai_explanations.question_id
        and q.teacher_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.questions q
      where q.id = ai_explanations.question_id
        and q.teacher_id = auth.uid()
    )
  );

-- No insert and no delete policy on purpose. A row is born in
-- `claim_ai_explanation()` and only ever moves through the two functions
-- above, which is how "one call per question" survives a bad route handler.

alter table public.ai_usage enable row level security;

-- A student reads their own counter, so the UI can say "7 of 30 used today".
create policy ai_usage_select_own on public.ai_usage
  for select to authenticated
  using (auth.uid() = user_id);

-- No write policy at all. The counter moves only inside
-- `claim_ai_explanation()` and `fail_ai_explanation()`, so a student cannot
-- zero it and buy themselves unlimited calls.
