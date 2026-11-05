-- 0014_saved.sql  (issue 14-saved-list)
--
-- PRD F-E8: ONE "Saved" list with TWO tags, Wrong and Marked. So this is one
-- table with a `tag` column, not two tables and not two flags somewhere else.
-- The Saved tab reads the whole list and the two chips filter it.
--
-- WHY `tag` IS IN THE PRIMARY KEY. A question a student got wrong AND marked
-- for later is one question in two chips, so it needs two rows. Leaving the
-- tag out of the key would make the second save overwrite the first, and the
-- question would quietly leave one of the two lists.
--
-- WHY THE KEY IS THE WHOLE DESIGN (the same reasoning as A1 in 0013). Two of
-- the three writes happen without the student asking:
--
--   * a wrong answer saves itself with the tag `wrong`, on every tap, and a
--     student taps a second option on the same question all the time;
--   * the player writes from a phone on 4G that drops.
--
-- So the SAME save arrives twice. `(user_id, question_id, tag)` plus
-- `on conflict ... do nothing` makes it IDEMPOTENT: the second send matches the
-- row that is already there and changes nothing. Without the key the Saved tab
-- would show the same question four times after four taps.
--
-- `created_at` IS NOT REWRITTEN on a repeat. The list is newest first, and the
-- moment that matters is when the question first went wrong, not the last time
-- a retry managed to land.
--
-- NO SPACED REPETITION (issue scope guard). There is no `due_at`, no interval
-- and no review counter here. A row is saved or it is not, and the student
-- removes it with the Remove button.
--
-- PRIVACY. A saved question says what a student got wrong, which is the same
-- class of secret as a score, so the policies are the strictest shape in the
-- app: `auth.uid() = user_id` on every one of them. Nobody else reads these
-- rows: not another student, and not the teacher who wrote the question. There
-- is no update policy, because all three columns are the key, so a change is a
-- delete plus an insert and both are covered (same shape as `follows` in 0006).

create table if not exists public.saved_questions (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  -- The question itself is the content, so the row dies with it: a paper the
  -- teacher deletes must not leave an unopenable row in the Saved tab.
  question_id uuid        not null references public.questions (id) on delete cascade,
  tag         text        not null,
  created_at  timestamptz not null default now(),

  -- F-E8: exactly two tags. A CHECK and not an enum, the same style as
  -- `papers.status` and `attempts.mode`, so a third tag is one migration away.
  constraint saved_questions_tag_check check (tag in ('wrong', 'marked')),

  constraint saved_questions_pkey primary key (user_id, question_id, tag)
);

comment on table public.saved_questions is
  'One Saved list per student with two tags, Wrong and Marked (PRD F-E8). PK (user_id, question_id, tag) makes the save idempotent, which is what lets a wrong answer save itself on every tap. RLS: own rows only, because a saved question says what the student got wrong. Issue 14-saved-list.';
comment on column public.saved_questions.tag is
  'wrong (the student answered it wrong) or marked (Mark for later). One question can carry both.';
comment on column public.saved_questions.created_at is
  'When the question was FIRST saved. A repeated save does not move it, so the list order is stable.';

-- The Saved tab asks "my rows, this tag, newest first", which is exactly the
-- chip filter. The primary key already covers "my rows" on its own.
create index if not exists saved_questions_user_tag_idx
  on public.saved_questions (user_id, tag, created_at desc);

alter table public.saved_questions enable row level security;

create policy saved_questions_select_own on public.saved_questions
  for select to authenticated
  using (auth.uid() = user_id);

-- The question is NOT re-checked here. A student can only ever read a live
-- question of an approved teacher (`questions_select_live` in 0011), so the id
-- they could save is already one they were handed, and the foreign key proves
-- the question exists at all.
create policy saved_questions_insert_own on public.saved_questions
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy saved_questions_delete_own on public.saved_questions
  for delete to authenticated
  using (auth.uid() = user_id);
