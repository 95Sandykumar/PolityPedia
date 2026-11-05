-- 0016_set_access.sql  (issue 16-set-access-mock-list)
--
-- WHO MAY READ A MOCK QUESTION. design.md, RLS section: "a student can read a
-- mock question only if `set_access` has a valid row for its set (purchase,
-- batch, admin) OR the test is a free sample."
--
-- That one sentence is the paywall. It does not live in a route handler, a
-- page or a React component, because every one of those can be skipped by
-- calling the REST API with the student's own token. It lives here.
--
-- Three things in this file:
--
--  * `set_access`           -- the row that says "this user owns this set".
--  * `has_test_access(uuid)`-- free sample, or a valid row. One function, so
--                              the player, the list and the policy agree.
--  * a RESTRICTIVE policy on `questions` -- the gate itself.
--
-- WHY RESTRICTIVE. 0011 already has `questions_select_live`, which lets any
-- signed-in user read a LIVE question of an APPROVED teacher. Postgres ORs
-- permissive policies together, so a second permissive policy would WIDEN the
-- read, never narrow it: adding one would have sold nothing. A RESTRICTIVE
-- policy is ANDed with the rest, so this file can tighten 0011 without
-- rewriting it, and the two slices never fight over the same policy name.
--
-- WHY `valid_until` IS NOT NULL. A nullable column would mean "forever", and
-- then every single reader has to remember `valid_until is null or
-- valid_until > now()`. Forgetting the first half locks a paying student out;
-- forgetting the second half gives a refunded set away forever. A bought set
-- stores 'infinity' instead, so there is ONE rule everywhere: valid_until >
-- now().
--
-- NO PAYMENTS HERE. Razorpay is issues 26 and 27, batch grants are issue 19.
-- This file stores the row those slices will write, and the only writer today
-- is an admin (source `admin`), which is what the definition of done asks for.

-- ---------------------------------------------------------------------------
-- set_access
-- ---------------------------------------------------------------------------

create table if not exists public.set_access (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  set_id      uuid        not null references public.mock_sets (id) on delete cascade,
  source      text        not null,
  valid_until timestamptz not null,
  created_at  timestamptz not null default now(),
  -- design.md: PK (user_id, set_id, source). The source is IN the key, so a
  -- student who both bought a set and sits in a batch that gives it away has
  -- two rows, and losing the batch does not take the purchase with it.
  constraint set_access_pkey primary key (user_id, set_id, source),
  constraint set_access_source_check check (source in ('purchase', 'batch', 'admin'))
);

comment on table public.set_access is
  'One reason one user may read one mock set''s questions. Valid while valid_until > now(). RLS: read your own row; only an admin writes one by hand. Issue 16-set-access-mock-list.';
comment on column public.set_access.source is
  'purchase = paid (issues 26, 27). batch = a teacher''s batch (issue 19). admin = granted by hand for testing and support (this issue).';
comment on column public.set_access.valid_until is
  'Access is live while this is in the future. NOT NULL on purpose: a bought set stores ''infinity'', so every reader has the one rule valid_until > now() and nobody has to remember a NULL case.';

-- "Who owns this set?" for a teacher report later, and the reverse direction
-- of the foreign key. The (user_id, set_id) direction the gate uses is already
-- the primary key's own prefix.
create index if not exists set_access_set_idx
  on public.set_access (set_id, valid_until desc);

alter table public.set_access enable row level security;

-- A student reads their OWN rows. That is how the mock list knows to print
-- "Unlocked" instead of a price, and it tells them nothing about anybody else.
create policy set_access_select_own on public.set_access
  for select to authenticated
  using (auth.uid() = user_id);

-- Only an admin writes a row by hand.
--
-- The admin test is INLINE and not `public.is_admin()`: that helper is created
-- in `0021_entitlements.sql`, migrations run in file-name order, and 0016 runs
-- first. Spelling it out here keeps this slice standing on its own instead of
-- depending on a file that may not be applied yet.
--
-- The subquery reads the CALLER'S OWN profiles row, which `profiles_select_own`
-- already allows, so no SECURITY DEFINER function is needed to answer it.
create policy set_access_admin_all on public.set_access
  for all to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- has_test_access(): the one answer to "is this test open to me?"
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER, so the check itself is not subject to the caller's own
-- policies on `mock_tests` and `set_access`. It returns a BOOLEAN and never a
-- row, so there is nothing to leak: the caller learns "open" or "shut" about a
-- test id they already hold.
--
-- The parameter is `for_test`, not `test_id`, so it can never be read as the
-- `questions.test_id` column it is compared against.
--
-- A NULL id is false, not NULL: a past-paper question has no test, and the
-- policy below deals with that case by itself.

create or replace function public.has_test_access(for_test uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select coalesce(
    (
      select
        t.is_free_sample
        or exists (
          select 1
          from public.set_access a
          where a.set_id = t.set_id
            and a.user_id = auth.uid()
            and a.valid_until > now()
        )
      from public.mock_tests t
      where t.id = for_test
    ),
    false
  )
$$;

comment on function public.has_test_access(uuid) is
  'True when the signed-in user may read one mock test''s questions: the test is the free sample, or set_access has a row for its set that has not expired. The one place that rule is written. Issue 16-set-access-mock-list.';

grant execute on function public.has_test_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The gate on questions
-- ---------------------------------------------------------------------------
--
-- RESTRICTIVE, so it is ANDed with `questions_select_live` from 0011 rather
-- than ORed with it. What a signed-in student ends up with is:
--
--   (live question of an approved teacher)  AND  (no test, or the test is open)
--
-- `test_id is null` lets every past-paper question through untouched: V8 says
-- past papers are FREE, and there is no set to unlock.
--
-- `auth.uid() = teacher_id` keeps the teacher's own screens working. A teacher
-- does not buy their own set, and `publish_mock_set()` reads their questions
-- while it moves them, so leaving this out would make a teacher unable to
-- publish the set they just wrote.

create policy questions_mock_needs_access on public.questions
  as restrictive
  for select to authenticated
  using (
    questions.test_id is null
    or auth.uid() = questions.teacher_id
    or public.has_test_access(questions.test_id)
  );

comment on policy questions_mock_needs_access on public.questions is
  'The mock paywall (design.md RLS): a mock question needs a valid set_access row or a free-sample test. RESTRICTIVE, so it narrows questions_select_live from 0011 instead of widening it. Issue 16-set-access-mock-list.';
