-- 0023_ai_feedback.sql  (issue 23-revision-screen)
--
-- Thumbs up / down under an AI explanation. DESIGN.md section 8: "Thumbs
-- up/down under it (feedback goes to the teacher)."
--
-- WHY THE KEY IS `(user_id, question_id, lang)`.
--
--  * ONE OPINION PER STUDENT. A student who taps up and then down has one
--    opinion, not two rows that cancel each other out. The upsert the screen
--    sends rewrites the row, so the teacher reads a current count and not a
--    history of taps.
--  * LANGUAGE IS PART OF IT, because `ai_explanations` is keyed by
--    `(question_id, lang)` too: the Hindi explanation of a question is a
--    different piece of writing from the English one, and a student may rate
--    one well and the other badly.
--
-- `user_id` DEFAULTS TO `auth.uid()`. The browser posts `{question_id, lang,
-- vote}` and never an id at all, so the worst a tampered request can do is
-- vote as itself. The `with check` below refuses an explicit id that is not
-- the caller's, so both halves are covered.
--
-- WHO READS IT. The student reads their own vote, so the screen can show the
-- thumb they already picked after a reload. The teacher who OWNS the question
-- reads every vote on it, because that is the whole point of collecting them
-- (issue 24 is the screen that shows them). Another student reads nothing: a
-- vote says a student paid for an explanation and did not like it, which is
-- the same class of secret as a score.
--
-- NO COUNTER COLUMN and no aggregate view here. The teacher screen counts
-- rows. A denormalised count would need a trigger, and a trigger that can
-- disagree with its table is worse than a `count(*)` over a few rows.

create table if not exists public.ai_feedback (
  -- The default is what the browser relies on: it posts no id.
  user_id     uuid        not null default auth.uid()
    references auth.users (id) on delete cascade,
  -- The vote dies with the question, like `saved_questions` in 0014: a paper
  -- the teacher deletes must not leave votes behind on nothing.
  question_id uuid        not null
    references public.questions (id) on delete cascade,
  lang        text        not null,
  vote        text        not null,
  created_at  timestamptz not null default now(),

  constraint ai_feedback_pkey primary key (user_id, question_id, lang),

  -- Same two languages an explanation can be written in (0022).
  constraint ai_feedback_lang_check check (lang in ('en', 'hi')),
  -- Two thumbs. A CHECK and not an enum, the same style as
  -- `ai_explanations.status`, so a third value is one migration away.
  constraint ai_feedback_vote_check check (vote in ('up', 'down'))
);

comment on table public.ai_feedback is
  'Thumbs up / down on one AI explanation. PK (user_id, question_id, lang) keeps it to one opinion per student per language. Feedback goes to the question''s teacher. Issue 23-revision-screen.';
comment on column public.ai_feedback.user_id is
  'Defaults to auth.uid(), so the browser posts no user id at all.';
comment on column public.ai_feedback.vote is
  'up (the explanation helped) or down (it did not). The teacher reads these.';

-- The teacher's read is "every vote on this question", which is also how a
-- later screen counts them. The primary key already covers the student's own.
create index if not exists ai_feedback_question_idx
  on public.ai_feedback (question_id, lang);

alter table public.ai_feedback enable row level security;

-- The student's own vote, so a reopened explanation shows the thumb they
-- already picked.
create policy ai_feedback_select_own on public.ai_feedback
  for select to authenticated
  using (auth.uid() = user_id);

-- The teacher who owns the question. The subquery runs as the CALLER, so
-- `public.questions`' own policies filter it and there is no second copy of
-- the ownership rule to drift.
create policy ai_feedback_select_owner on public.ai_feedback
  for select to authenticated
  using (
    exists (
      select 1
      from public.questions q
      where q.id = ai_feedback.question_id
        and q.teacher_id = auth.uid()
    )
  );

-- The question is NOT re-checked here. A student can only ever read a live
-- question of an approved teacher (`questions_select_live` in 0011), so the id
-- they could vote on is one they were handed, and the foreign key proves the
-- question exists at all.
create policy ai_feedback_insert_own on public.ai_feedback
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Changing your mind. `with check` repeats the test, so an update cannot move
-- a row onto another student.
create policy ai_feedback_update_own on public.ai_feedback
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Taking the vote back.
create policy ai_feedback_delete_own on public.ai_feedback
  for delete to authenticated
  using (auth.uid() = user_id);
