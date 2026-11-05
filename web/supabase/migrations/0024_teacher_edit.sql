-- 0024_teacher_edit.sql  (issue 24-revision-teacher-edit)
--
-- F7 is the human gate on AI text, and F-F4 names who closes it: the teacher
-- whose question it is. 0022 already gave that teacher an update policy. This
-- file makes the edit HONEST, which is the part a route handler cannot do:
--
--   1. an update by the question's teacher MUST set `edited_by_teacher`, so a
--      corrected explanation can never still be labelled "AI" on a student's
--      screen. It is a `with check`, not a convention in a client.
--   2. an edited row keeps the model name and the token counts of the call
--      that paid for it, stays `ready`, and stays on its own question and
--      language. So an edit cannot be dressed up as a fresh AI call, and a
--      late retry cannot overwrite the correction.
--   3. an edited body has something to render. The teacher is the human gate;
--      a blank gate is worse than no gate.
--
-- There is no version history in this slice (scope guard): the corrected text
-- replaces the AI text, and `edited_by_teacher` is the whole audit trail.

-- --------------------------------------------------------------------------
-- The flag is required, not optional
-- --------------------------------------------------------------------------
--
-- 0022's policy answered "may you write this row". This one also answers
-- "what must be true of the row you wrote". `using` is unchanged, so who may
-- edit is still decided by `questions.teacher_id`, in one place.
--
-- Dropped and recreated rather than altered, because Postgres has no
-- `alter policy ... with check` that can be re-run safely.
drop policy if exists ai_explanations_update_owner on public.ai_explanations;

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
    -- The new part. An edit that leaves the flag false is refused outright,
    -- so there is no path from this policy to text a student would still see
    -- credited to the model.
    edited_by_teacher
    and exists (
      select 1
      from public.questions q
      where q.id = ai_explanations.question_id
        and q.teacher_id = auth.uid()
    )
  );

comment on policy ai_explanations_update_owner on public.ai_explanations is
  'The question''s teacher may correct the text, and the corrected row must carry edited_by_teacher. F7 and F-F4. Issue 24-revision-teacher-edit.';

-- --------------------------------------------------------------------------
-- An edited body has something to render
-- --------------------------------------------------------------------------
--
-- At least one section, and no section with an empty or non-string body. Same
-- jsonpath idiom as `questions_options_check` in 0011: the path asks "is there
-- any element that is broken", and the constraint holds when there is not.
--
-- `coalesce(..., false)`: `@?` on a NULL body is NULL, and a NULL check
-- constraint PASSES. Without the coalesce an edit that blanked the body would
-- slip through here and only be caught by the `ready_has_body` check, which
-- is a worse error message for the same mistake.
alter table public.ai_explanations
  drop constraint if exists ai_explanations_edited_body_check;

alter table public.ai_explanations
  add constraint ai_explanations_edited_body_check check (
    not edited_by_teacher
    or (
      coalesce(body @? '$.sections[0]', false)
      and not coalesce(
        body @? '$.sections[*] ? (@.body.type() != "string" || @.body == "")',
        false
      )
    )
  );

-- --------------------------------------------------------------------------
-- What an edit may and may not change
-- --------------------------------------------------------------------------
--
-- The policy decides WHO. This decides WHAT, for the columns a teacher has no
-- business in. A `before update` trigger, not more `with check` clauses,
-- because `with check` can only refuse: it cannot compare the new row to the
-- old one, and `old` is what the cost columns have to stay equal to.
--
-- It fires only `when (new.edited_by_teacher)`, so the three AI functions in
-- 0022 are untouched: `claim`, `finish` and `fail` never set the flag, and
-- neither of the two that write to a live row can reach an edited one anyway
-- (both are keyed on `status`, and an edited row is always `ready`).
create or replace function public.ai_explanation_teacher_edit()
returns trigger
language plpgsql
as $$
begin
  -- Identity. Without this an update could move the correction onto another
  -- question, or into the other language, both of which the policy would
  -- happily re-approve because the teacher owns both.
  new.question_id := old.question_id;
  new.lang        := old.lang;
  new.created_at  := old.created_at;

  -- A corrected explanation is readable, full stop. This also closes the
  -- retry hole: parked in `generating` the row could be overwritten by a late
  -- `finish_ai_explanation()`, and parked in `failed` it could be re-claimed.
  new.status := 'ready';

  -- Cost and provenance belong to the call that was paid for (AS3, H3). A
  -- teacher rewriting the text does not change which model was billed.
  new.model      := old.model;
  new.tokens_in  := old.tokens_in;
  new.tokens_out := old.tokens_out;
  new.searches   := old.searches;

  -- Sources came out of the model's web search. Editing them is not in this
  -- slice, so they are pinned rather than silently half-trusted.
  new.sources := old.sources;

  -- Narration (issue 25) is read aloud from `body`. New text means the old
  -- audio is now wrong, and wrong audio is worse than none, so it is dropped
  -- and left for issue 25 to make again.
  if new.body is distinct from old.body then
    new.audio_path := null;
  else
    new.audio_path := old.audio_path;
  end if;

  return new;
end;
$$;

comment on function public.ai_explanation_teacher_edit() is
  'Pins everything a teacher edit may not change: the row identity, the ready status, and the model and token columns. Drops stale audio. Issue 24-revision-teacher-edit.';

drop trigger if exists ai_explanations_teacher_edit on public.ai_explanations;

create trigger ai_explanations_teacher_edit
  before update on public.ai_explanations
  for each row
  when (new.edited_by_teacher)
  execute function public.ai_explanation_teacher_edit();
