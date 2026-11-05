-- 0036_practice_verdict_reads_key.sql
--
-- Joins issue 30 (answer key locked) with issue 31 (the server owns the
-- verdict). They were built in parallel and clash:
--
--   * 30 revoked SELECT on questions.correct_idx from `authenticated`.
--   * 31's trigger `attempt_answers_server_owns_verdict` runs as the caller
--     and reads questions.correct_idx to mark a practice answer.
--
-- Result: every practice answer a student saved failed with "permission denied
-- for table questions".
--
-- FIX. The key is read by ONE narrow definer function, `practice_verdict()`,
-- and the trigger calls it. The function:
--
--   * answers only for the caller's OWN practice sitting,
--   * only for a question the caller may read (own question as a teacher, or a
--     live question of an approved teacher whose set they hold),
--   * returns NULL, never the key, and returns NULL while the caller has an
--     open exam sitting for that test. NULL fails closed: the 0018 check
--     allows it and score_attempt() repairs it at submit.
--
-- It returns a boolean ("is this choice right"), not the key, and it is the
-- same fact practice mode shows after each answer by design.

create or replace function public.practice_verdict(
  for_attempt uuid,
  for_question uuid,
  chosen integer
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  caller uuid := auth.uid();
  q_test uuid;
  q_teacher uuid;
  q_status text;
  q_key integer;
  sitting_user uuid;
  sitting_mode text;
begin
  if caller is null then
    return null;
  end if;

  select a.user_id, a.mode into sitting_user, sitting_mode
  from public.attempts a
  where a.id = for_attempt;

  if sitting_user is distinct from caller or sitting_mode is distinct from 'practice' then
    return null;
  end if;

  select q.test_id, q.teacher_id, q.status, q.correct_idx
    into q_test, q_teacher, q_status, q_key
  from public.questions q
  where q.id = for_question;

  if not found then
    return null;
  end if;

  -- An open exam sitting for this test: no verdict, ever.
  if q_test is not null and q_teacher <> caller and public.has_open_exam(q_test) then
    return null;
  end if;

  -- The same read rules question_keys() states (0030).
  if not (
    q_teacher = caller
    or (
      q_status = 'live'
      and exists (select 1 from public.teachers_public tp where tp.user_id = q_teacher)
      and (q_test is null or public.has_test_access(q_test))
    )
  ) then
    return null;
  end if;

  return (q_key = chosen);
end;
$$;

comment on function public.practice_verdict(uuid, uuid, integer) is
  'Is this choice right, for the caller''s own practice sitting. Returns a boolean, never the key, and NULL when the caller may not know (not their sitting, not readable, or an exam sitting of that test is open). Used by attempt_answers_server_owns_verdict(). Joins issues 30 and 31.';

revoke all on function public.practice_verdict(uuid, uuid, integer) from public, anon;
grant execute on function public.practice_verdict(uuid, uuid, integer) to authenticated;

create or replace function public.attempt_answers_server_owns_verdict()
returns trigger
language plpgsql
set search_path = public, auth, pg_temp
as $$
declare
  sitting_mode text;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  select a.mode into sitting_mode
  from public.attempts a
  where a.id = new.attempt_id;

  if sitting_mode is distinct from 'practice' then
    if tg_op = 'INSERT' then
      if new.is_correct is not null then
        raise exception 'attempt_answers.is_correct is written by score_attempt(), not by the caller'
          using errcode = '42501';
      end if;
    elsif new.is_correct is distinct from old.is_correct then
      raise exception 'attempt_answers.is_correct is written by score_attempt(), not by the caller'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- `chosen_idx` null ("marked for later") gives NULL, which keeps the
  -- no-verdict state 0013 describes.
  new.is_correct := public.practice_verdict(new.attempt_id, new.question_id, new.chosen_idx);
  return new;
end;
$$;
