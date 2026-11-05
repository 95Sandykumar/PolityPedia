-- 0015_mock_sets.sql  (issue 15-mock-sets-authoring)
--
-- V10 and V11: a teacher builds a MOCK SET for one exam, fills it with tests,
-- prices it BETWEEN Rs 299 AND Rs 399, and publishes it. Test 1 may be a free
-- sample, so a student can try the teacher's style before paying.
--
-- Three tables' worth of rules in two tables and one function:
--
--  * `mock_sets`  -- the product: one exam, one title, one price, one owner.
--  * `mock_tests` -- the tests inside it, in order. Position 1 may be free.
--  * `publish_mock_set(set_id)` -- the one way a set goes live.
--
-- WHERE THE PRICE RULE LIVES. `mock_sets_price_check` is a CHECK, not a form
-- rule and not a policy: V11 fixes the band at Rs 299 to Rs 399, so no route
-- handler, no admin screen and no future import script can store Rs 99 or
-- Rs 4,999. The stepper in the UI moves in Rs 10 steps, which is a comfort for
-- the thumb, NOT a database rule: a teacher who already sells at Rs 345 must
-- keep selling at Rs 345.
--
-- WHERE THE FREE-SAMPLE RULE LIVES. `mock_tests_free_sample_check`. V11 says
-- "Test 1 can be a free sample", and position 1 IS Test 1, so a free test at
-- position 4 is not a generous teacher, it is a bug that gives the whole set
-- away one test at a time.
--
-- `questions.test_id` BECOMES A REAL FOREIGN KEY HERE. 0011 left it a plain
-- uuid with a comment saying so, because that file would not apply against a
-- database with no `mock_tests` table. Migrations run in file-name order, so
-- 0011 is already there and this is the first moment the reference can exist.
--
-- NO PAYMENTS AND NO BATCH GRANTS. Taking the money is issues 26 and 27;
-- handing a set to a batch is issue 19. This file stores what a set COSTS, and
-- nothing about what anybody paid.

-- ---------------------------------------------------------------------------
-- mock_sets
-- ---------------------------------------------------------------------------
create table if not exists public.mock_sets (
  id         uuid        primary key default gen_random_uuid(),
  teacher_id uuid        not null references public.teachers (user_id) on delete cascade,
  exam_id    uuid        not null references public.exams (id) on delete cascade,
  title      text        not null,
  -- Rs 299 is the floor and the default, so a half-filled insert is the
  -- cheapest set and never a free one.
  price_inr  integer     not null default 299,
  status     text        not null default 'draft',
  created_at timestamptz not null default now(),

  -- One line on a 360 px phone, so the title stays short.
  constraint mock_sets_title_check check (length(btrim(title)) between 1 and 80),

  -- V11. The whole pricing rule, in one line, in the database.
  constraint mock_sets_price_check check (price_inr between 299 and 399),

  constraint mock_sets_status_check check (status in ('draft', 'live')),

  -- One set with that title per exam per teacher. Two "Full length set 1"
  -- rows under UGC NET are the same set typed twice, and the teacher would
  -- then price and publish the wrong one. The exam is part of the key, so the
  -- same title under CUET PG is a different product and is allowed.
  constraint mock_sets_title_unique unique (teacher_id, exam_id, title)
);

comment on table public.mock_sets is
  'One priced mock set (V10, V11). Rs 299 to Rs 399, teacher-chosen, enforced by a CHECK. A set is a draft until publish_mock_set(). RLS: the teacher writes their own; any signed-in user reads a LIVE set of an APPROVED teacher. Issue 15-mock-sets-authoring.';
comment on column public.mock_sets.price_inr is
  'V11: Rs 299 to Rs 399, chosen by the teacher. GST 18% is INSIDE this number and the gateway fee is about 2% (AS6, unverified), so the teacher''s share is worked out on the net amount (X3).';
comment on column public.mock_sets.status is
  'draft until publish_mock_set(). A student only ever reads a live set.';

-- The student-facing read is "this teacher's live sets", newest first.
create index if not exists mock_sets_teacher_live_idx
  on public.mock_sets (teacher_id, status, created_at desc);

alter table public.mock_sets enable row level security;

-- READ. The teacher sees everything of their own, drafts included, because
-- that is the authoring screen. Anybody else only ever gets a `live` set of an
-- APPROVED teacher.
--
-- The subquery hits `public.teachers_public`, NOT `public.teachers`: a policy
-- subquery runs as the caller, a student has no select policy on `teachers`,
-- so a subquery over the table would always come back empty. `teachers_public`
-- is an owner-rights view that already filters `status = 'approved'` (0005).
-- Same shape as `questions_select_live` in 0011.
create policy mock_sets_select_live on public.mock_sets
  for select to authenticated
  using (
    auth.uid() = teacher_id
    or (
      status = 'live'
      and exists (
        select 1
        from public.teachers_public tp
        where tp.user_id = mock_sets.teacher_id
      )
    )
  );

create policy mock_sets_insert_own on public.mock_sets
  for insert to authenticated
  with check (auth.uid() = teacher_id);

-- Both halves are needed: without `with check`, an update could rewrite
-- `teacher_id` and hand the set, and its revenue, to another teacher.
create policy mock_sets_update_own on public.mock_sets
  for update to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy mock_sets_delete_own on public.mock_sets
  for delete to authenticated
  using (auth.uid() = teacher_id);

-- ---------------------------------------------------------------------------
-- mock_tests
-- ---------------------------------------------------------------------------
create table if not exists public.mock_tests (
  id             uuid        primary key default gen_random_uuid(),
  set_id         uuid        not null references public.mock_sets (id) on delete cascade,
  title          text        not null,
  position       integer     not null,
  duration_min   integer     not null default 60,
  is_free_sample boolean     not null default false,
  created_at     timestamptz not null default now(),

  constraint mock_tests_title_check    check (length(btrim(title)) between 1 and 80),
  constraint mock_tests_position_check check (position between 1 and 100),
  -- 1 minute to 6 hours. A real paper is 2 to 3 hours; the wide band leaves
  -- room for a 10-minute topic test without another migration.
  constraint mock_tests_duration_check check (duration_min between 1 and 360),

  -- V11: "Test 1 can be a free sample". Position 1 IS Test 1, so a free test
  -- anywhere else would give the paid set away one test at a time.
  --
  -- Read it as an implication: free sample => position 1.
  constraint mock_tests_free_sample_check
    check (not is_free_sample or position = 1)
);

comment on table public.mock_tests is
  'The tests inside one mock set, in order. Only position 1 may be the free sample (V11), enforced by a CHECK. RLS is inherited from the parent set: whoever may read the set may read its tests, and only the owner may write them. Issue 15-mock-sets-authoring.';
comment on column public.mock_tests.position is
  'Test 1, 2, 3 ... Unique inside the set, so the list never shows "Test 2" twice.';
comment on column public.mock_tests.is_free_sample is
  'V11: the one free test a student may take before paying. Position 1 only.';

-- One test per position inside a set, and the same index answers the "tests of
-- this set, in order" read the authoring screen does.
create unique index if not exists mock_tests_set_position_idx
  on public.mock_tests (set_id, position);

alter table public.mock_tests enable row level security;

-- READ. "Can I read the parent set?" and nothing else.
--
-- An RLS policy subquery runs as the CALLER, so `mock_sets_select_live` is
-- evaluated inside this EXISTS. That is the point: the two tables can never
-- drift apart, because there is only one rule and it lives on `mock_sets`.
create policy mock_tests_select_parent on public.mock_tests
  for select to authenticated
  using (
    exists (
      select 1
      from public.mock_sets s
      where s.id = mock_tests.set_id
    )
  );

-- WRITE. The OWNER only, which is a stricter question than the read: a live
-- set is readable by every student, and none of them may add a test to it.
create policy mock_tests_insert_own on public.mock_tests
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.mock_sets s
      where s.id = mock_tests.set_id
        and s.teacher_id = auth.uid()
    )
  );

-- `using` and `with check` are both the owner test, so a test cannot be moved
-- from the owner's set into somebody else's set, or out of it.
create policy mock_tests_update_own on public.mock_tests
  for update to authenticated
  using (
    exists (
      select 1 from public.mock_sets s
      where s.id = mock_tests.set_id and s.teacher_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.mock_sets s
      where s.id = mock_tests.set_id and s.teacher_id = auth.uid()
    )
  );

create policy mock_tests_delete_own on public.mock_tests
  for delete to authenticated
  using (
    exists (
      select 1 from public.mock_sets s
      where s.id = mock_tests.set_id and s.teacher_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- questions.test_id -> mock_tests.id
--
-- The reference 0011 promised. `add constraint` has no `if not exists` form,
-- so the catalogue is asked first and the whole migration stays re-runnable.
--
-- `on delete cascade`: deleting a test deletes its questions. They have no
-- other parent (`questions_one_parent_check` is an XOR), so an orphan would be
-- a row nobody can ever reach or delete.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'questions_test_fkey'
      and conrelid = 'public.questions'::regclass
  ) then
    alter table public.questions
      add constraint questions_test_fkey
      foreign key (test_id) references public.mock_tests (id) on delete cascade;
  end if;
end;
$$;

comment on column public.questions.test_id is
  'Mock test this question belongs to. A real FOREIGN KEY to mock_tests since issue 15-mock-sets-authoring.';

-- One question number per test, the mock-set twin of
-- `questions_paper_number_idx` in 0011: a test must not show "question 7"
-- twice. Partial, because a past-paper question has no `test_id` and they
-- would all collide on NULL.
create unique index if not exists questions_test_number_unique_idx
  on public.questions (test_id, number)
  where test_id is not null;

-- ---------------------------------------------------------------------------
-- The owner guard for `test_id`.
--
-- `papers` solved the same problem with a COMPOSITE foreign key
-- (teacher_id, paper_id), because `papers` carries a `teacher_id`.
-- `mock_tests` does not: the owner lives one level up, on `mock_sets`, so no
-- foreign key can express "this test's set is yours" and a trigger has to.
--
-- Without it, teacher A could insert a question with their own `teacher_id`
-- and teacher B's `test_id`. RLS would still hide the row from B's screens,
-- but the row would exist, and B's published test would carry it.
--
-- SECURITY DEFINER on purpose, unlike 0005's guards: the lookup must see every
-- set, including another teacher's DRAFT one, which the caller's own
-- `mock_sets_select_live` policy would hide. Hiding it would turn the guard
-- into "refuse only the sets you can see", which is the opposite of a guard.
-- It reads two ids and returns nothing, so there is no data path out of it.
-- ---------------------------------------------------------------------------
create or replace function public.questions_test_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.test_id is not null then
    if not exists (
      select 1
      from public.mock_tests t
      join public.mock_sets s on s.id = t.set_id
      where t.id = new.test_id
        and s.teacher_id = new.teacher_id
    ) then
      raise exception 'that mock test belongs to another teacher'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.questions_test_owner_guard() is
  'Refuses a question whose mock test sits in another teacher''s set. The owner lives on mock_sets, one level above mock_tests, so a composite foreign key cannot express it. Issue 15-mock-sets-authoring.';

drop trigger if exists questions_test_owner_guard on public.questions;

create trigger questions_test_owner_guard
  before insert or update on public.questions
  for each row
  execute function public.questions_test_owner_guard();

-- ---------------------------------------------------------------------------
-- publish_mock_set(set_id) -- the ONLY way a set and its questions go live.
--
-- Returns how many questions it published.
--
-- The same shape as `publish_paper()` in 0011, and for the same reasons:
--
--  * SECURITY INVOKER (the default), so both UPDATEs run through the CALLER's
--    own RLS and there is no second permission model to keep in step.
--  * A function body is one transaction, so the set and its questions move
--    together or not at all. A RAISE rolls the whole thing back.
--  * plpgsql, not sql, so the parameter can be written
--    `publish_mock_set.set_id`. In a LANGUAGE SQL body a bare `set_id` would
--    silently resolve to the mock_tests COLUMN and the filter would match
--    every row.
--
-- Three refusals, in the order a teacher meets them:
--
--  1. no tests at all. A live set with nothing in it is a set a student pays
--     Rs 299 for and cannot open. Unlike a past paper, where the PDF itself is
--     the content, a set with no tests has no content whatsoever.
--  2. an unchecked question (V9, PRD F-D3). Same rule as a past paper: the AI
--     split is never trusted, so nothing a teacher has not read goes live.
--  3. somebody else's set.
-- ---------------------------------------------------------------------------
create or replace function public.publish_mock_set(set_id uuid)
returns integer
language plpgsql
volatile
as $$
declare
  owner     uuid;
  tests     integer;
  unchecked integer;
  published integer;
begin
  -- RLS applies here, so a set the caller may not even read comes back NULL
  -- and is reported as "not found", never as "not yours".
  select s.teacher_id into owner
  from public.mock_sets s
  where s.id = publish_mock_set.set_id;

  if owner is null then
    raise exception 'mock set not found'
      using errcode = 'no_data_found';
  end if;

  -- A student can READ a live set, so the ownership check is a separate
  -- question from the read above.
  if owner <> auth.uid() then
    raise exception 'mock set belongs to another teacher'
      using errcode = 'insufficient_privilege';
  end if;

  select count(*) into tests
  from public.mock_tests t
  where t.set_id = publish_mock_set.set_id;

  if tests = 0 then
    raise exception 'mock set has no tests'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- V9: publish stays off until every question is checked.
  select count(*) into unchecked
  from public.questions q
  join public.mock_tests t on t.id = q.test_id
  where t.set_id = publish_mock_set.set_id
    and not q.checked;

  if unchecked > 0 then
    raise exception 'mock set has % unchecked question(s)', unchecked
      using errcode = 'check_violation';
  end if;

  -- Questions FIRST, then the set. If the question update were to fail, the
  -- set would never have been flipped, so a student can never reach a live
  -- set whose questions are still drafts.
  update public.questions q
  set status = 'live'
  where q.test_id in (
    select t.id from public.mock_tests t where t.set_id = publish_mock_set.set_id
  );
  get diagnostics published = row_count;

  update public.mock_sets
  set status = 'live'
  where id = publish_mock_set.set_id;

  return published;
end;
$$;

comment on function public.publish_mock_set(uuid) is
  'Publish one mock set: refuses an empty set, somebody else''s set, or any unchecked question, then sets the questions and the set live in one transaction. SECURITY INVOKER, so RLS decides. Issue 15-mock-sets-authoring.';

grant execute on function public.publish_mock_set(uuid) to authenticated;

-- A set with tests but NO questions is allowed to go live: "every question is
-- checked" is trivially true when there are none, and a teacher who built the
-- shell today and types the questions tomorrow would otherwise be stuck. The
-- player shows an empty test, which is visible and fixable; a set that cannot
-- be published is neither.
