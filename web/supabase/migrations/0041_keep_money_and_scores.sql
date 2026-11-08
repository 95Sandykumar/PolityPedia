-- 0041_keep_money_and_scores.sql
--
-- Issue 45-keep-money-and-scores. Deleting a mock set, a mock test, a past
-- paper or a batch must NEVER erase a payment, a paid student's access, or a
-- student's score.
--
-- THE BUG. `purchases.set_id` was `on delete cascade` (0026). A teacher who
-- deleted a mock set (policy `mock_sets_delete_own`) erased the payment rows,
-- the `set_access` rows (paid students lost their set) and, through
-- `mock_tests -> attempts`, every student's score. 0013 did the same for
-- papers.
--
-- WHAT THIS DOES
--   1. Five foreign keys go from `on delete cascade` to `on delete restrict`
--      (the list below is complete; nothing else was changed).
--   2. `archived_at timestamptz` on mock_sets, mock_tests, papers, batches.
--   3. Student read policies hide archived rows from browse lists, EXCEPT for
--      a student who holds set_access for the set, or has an attempt on it.
--   4. The teacher DELETE policies on the four tables are dropped. The only
--      way to remove one is now remove_mock_set / remove_mock_test /
--      remove_paper / remove_batch, which hard-delete only when nothing
--      depends on the row and otherwise archive it. restore_* undoes an
--      archive within 30 days.
--   5. Archiving a batch withdraws the set_access it handed out, through the
--      same refresh_batch_access() path the member and set triggers use.
--      batch_report_* are owner-rights views that never looked at archive
--      state, so the teacher's reports stay readable.
--   6. A new sitting cannot start on an archived test or an archived paper.
--      An archived SET does not stop a buyer sitting its other tests.
--   7. A paid student cannot start a NEW purchase of an archived set.
--
-- CASCADES CHANGED (every one; all went from `on delete cascade` to `restrict`)
--   * purchases.set_id        -> mock_sets   (the bug in the title)
--   * teacher_ledger.purchase_id -> purchases (a ledger row must outlive any
--                                  attempt to delete its purchase)
--   * set_access.set_id       -> mock_sets   (a paid or granted student's
--                                  access must not vanish with the set)
--   * attempts.test_id        -> mock_tests  (a score must not vanish with
--                                  the test or, through mock_tests.set_id,
--                                  with the set)
--   * attempts.paper_id       -> papers      (same, for past papers)
-- CASCADES LEFT AS THEY WERE, and why they are now safe
--   * mock_tests.set_id -> mock_sets cascade: a set with any attempt is
--     refused by attempts.test_id above, so only an empty set loses tests.
--   * questions.test_id / paper_id cascade: only reached for a test or paper
--     with no attempt, because the attempts FK refuses first.
--   * batch_sets / batch_members -> batches cascade: remove_batch only
--     hard-deletes a batch with no member rows.
--   * purchases.user_id -> auth.users cascade: deleting a whole ACCOUNT is the
--     admin's call and out of scope for this ticket (design.md section 5).
--     NOTE: account deletion is now REFUSED while money rows exist.
--     purchases.user_id -> auth.users still cascades, but its child
--     teacher_ledger.purchase_id is now RESTRICT, so a buyer with a ledgered
--     purchase cannot be deleted. A teacher with a sold set cannot be deleted
--     either: teachers -> mock_sets cascades into purchases.set_id, which is
--     RESTRICT. A deletion request needs an anonymise-then-delete path
--     (see web/GO-LIVE.md). That path is not built here.
--
-- DECISION. The remove_* / restore_* functions are SECURITY DEFINER, not
-- INVOKER as the ticket text says. An invoker function cannot work here: the
-- caller has no DELETE policy any more (that is the point), and RLS hides
-- other students' purchases, set_access and attempts, which are exactly what
-- the function must count. Each function therefore checks `auth.uid()` owns
-- the row first and answers "not found" (P0002) to a stranger, the same shape
-- as publish_mock_set().
--
-- ROLLBACK (manual; archived data is kept, nothing is lost):
--   drop function public.remove_mock_set(uuid), public.remove_mock_test(uuid),
--     public.remove_paper(uuid), public.remove_batch(uuid),
--     public.restore_mock_set(uuid), public.restore_mock_test(uuid),
--     public.restore_paper(uuid), public.restore_batch(uuid);
--   drop trigger batches_sync_access_on_archive on public.batches;
--   drop trigger *_archive_guard on the four tables;
--   drop policy attempts_no_new_on_archived on public.attempts;
--   drop trigger purchases_refuse_archived_set on public.purchases;
--   recreate the four *_delete_own policies from 0010, 0015, 0019;
--   restore the policies, has_test_access(), refresh_batch_access() and
--     join_batch() from 0015/0010/0019/0016/0019 (this file replaced them);
--   re-create the five foreign keys above with `on delete cascade`;
--   alter table ... drop column archived_at on the four tables.
--
-- NOT TOUCHED: scoring, payment and webhook logic; start_set_purchase() keeps
-- its text (the purchase guard is a trigger, section 7); migrations 0002-0040.

-- ---------------------------------------------------------------------------
-- 1. The five foreign keys: cascade -> restrict
-- ---------------------------------------------------------------------------
--
-- Looked up in the catalogue by (table, column, parent) instead of by the
-- default constraint name, so a database where a constraint was renamed by
-- hand still ends up with exactly one restrict FK. Re-runnable.
do $$
declare
  r record;
  c text;
begin
  for r in
    select * from (values
      ('purchases',      'set_id',      'mock_sets',  'purchases_set_id_fkey'),
      ('teacher_ledger', 'purchase_id', 'purchases',  'teacher_ledger_purchase_id_fkey'),
      ('set_access',     'set_id',      'mock_sets',  'set_access_set_id_fkey'),
      ('attempts',       'test_id',     'mock_tests', 'attempts_test_fkey'),
      ('attempts',       'paper_id',    'papers',     'attempts_paper_id_fkey')
    ) as v(child, col, parent, cname)
  loop
    for c in
      select con.conname
      from pg_constraint con
      where con.contype = 'f'
        and con.conrelid = ('public.' || r.child)::regclass
        and con.confrelid = ('public.' || r.parent)::regclass
        and con.conkey = array[
          (select a.attnum from pg_attribute a
            where a.attrelid = con.conrelid and a.attname = r.col)
        ]::int2[]
    loop
      execute format('alter table public.%I drop constraint %I', r.child, c);
    end loop;

    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references public.%I (id) on delete restrict',
      r.child, r.cname, r.col, r.parent
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. archived_at
-- ---------------------------------------------------------------------------
alter table public.mock_sets  add column if not exists archived_at timestamptz;
alter table public.mock_tests add column if not exists archived_at timestamptz;
alter table public.papers     add column if not exists archived_at timestamptz;
alter table public.batches    add column if not exists archived_at timestamptz;

comment on column public.mock_sets.archived_at is
  'Set by remove_mock_set() when a purchase, an access row or an attempt depends on the set. NULL = live in the teacher''s list. Hidden from browse lists; a student who holds access or has an attempt still opens it. Restorable for 30 days. Issue 45-keep-money-and-scores.';
comment on column public.mock_tests.archived_at is
  'Set by remove_mock_test(). An archived test takes no NEW attempt; old results stay. Issue 45-keep-money-and-scores.';
comment on column public.papers.archived_at is
  'Set by remove_paper() when attempts exist. Hidden from the browse list; students with an attempt still see their results. Issue 45-keep-money-and-scores.';
comment on column public.batches.archived_at is
  'Set by remove_batch() when the batch has members. Its batch-granted set_access is withdrawn; batch_report_* stay readable for the teacher. Issue 45-keep-money-and-scores.';

-- archived_at moves only through the remove_*/restore_* functions. Those run
-- as the function owner, so `current_user` is not `authenticated` inside them.
-- A teacher patching the column straight through PostgREST (to dodge the
-- 30-day window) is refused. The service role and the migration owner are not
-- blocked, so support work and tests can still set a date.
create or replace function public.archive_guard()
returns trigger
language plpgsql
as $$
begin
  if new.archived_at is distinct from old.archived_at
     and current_user in ('authenticated', 'anon') then
    raise exception 'use the remove and restore functions to change archived_at'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.archive_guard() is
  'Refuses a direct change of archived_at from the authenticated or anon role. The remove_* and restore_* functions (SECURITY DEFINER) are the only door. Issue 45-keep-money-and-scores.';

drop trigger if exists mock_sets_archive_guard on public.mock_sets;
create trigger mock_sets_archive_guard
  before update on public.mock_sets
  for each row execute function public.archive_guard();
drop trigger if exists mock_tests_archive_guard on public.mock_tests;
create trigger mock_tests_archive_guard
  before update on public.mock_tests
  for each row execute function public.archive_guard();
drop trigger if exists papers_archive_guard on public.papers;
create trigger papers_archive_guard
  before update on public.papers
  for each row execute function public.archive_guard();
drop trigger if exists batches_archive_guard on public.batches;
create trigger batches_archive_guard
  before update on public.batches
  for each row execute function public.archive_guard();

-- ---------------------------------------------------------------------------
-- 3. Who may still see an archived row
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER booleans about an id the caller already holds, so a policy
-- on mock_sets can ask about attempts and set_access without recursing into
-- their own policies (same reason as owns_batch / has_test_access).

-- The student holds access to the set (any source, any expiry: the questions
-- stay gated by has_test_access(), this only decides whether the row is
-- visible), or has sat any test of it.
create or replace function public.keeps_set(for_set uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select
    exists (
      select 1
      from public.set_access a
      where a.set_id = for_set
        and a.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.attempts att
      join public.mock_tests t on t.id = att.test_id
      where t.set_id = for_set
        and att.user_id = auth.uid()
    )
$$;

comment on function public.keeps_set(uuid) is
  'True when the signed-in user holds set_access for the set or has an attempt on one of its tests. Lets an archived set stay open for them. Issue 45-keep-money-and-scores.';

create or replace function public.keeps_test(for_test uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select
    exists (
      select 1
      from public.attempts att
      where att.test_id = for_test
        and att.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.mock_tests t
      where t.id = for_test
        and public.keeps_set(t.set_id)
    )
$$;

comment on function public.keeps_test(uuid) is
  'True when the signed-in user has an attempt on the test, or keeps its set. Issue 45-keep-money-and-scores.';

create or replace function public.keeps_paper(for_paper uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.attempts att
    where att.paper_id = for_paper
      and att.user_id = auth.uid()
  )
$$;

comment on function public.keeps_paper(uuid) is
  'True when the signed-in user has an attempt on the past paper. Issue 45-keep-money-and-scores.';

-- "May a NEW sitting start here?" Only when the TEST itself is archived. An
-- archived SET does not block a buyer: they paid for every test in it and keep
-- access until valid_until (design.md section 5). Someone who does not hold the
-- set is kept out already: has_test_access() withholds the free sample of an
-- archived set, and attempts_mock_needs_access needs access for the rest.
create or replace function public.test_is_archived(for_test uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select coalesce(
    (select t.archived_at is not null from public.mock_tests t where t.id = for_test),
    false
  )
$$;

comment on function public.test_is_archived(uuid) is
  'True when the test itself is archived. A new sitting is refused for it. An archived set does not block a student who holds access to it. Issue 45-keep-money-and-scores.';

create or replace function public.paper_is_archived(for_paper uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select coalesce(
    (select p.archived_at is not null from public.papers p where p.id = for_paper),
    false
  )
$$;

comment on function public.paper_is_archived(uuid) is
  'True when the past paper is archived. A new sitting is refused for it. Issue 45-keep-money-and-scores.';

revoke all on function public.keeps_set(uuid)          from public, anon;
revoke all on function public.keeps_test(uuid)         from public, anon;
revoke all on function public.keeps_paper(uuid)        from public, anon;
revoke all on function public.test_is_archived(uuid)   from public, anon;
revoke all on function public.paper_is_archived(uuid)  from public, anon;
grant execute on function public.keeps_set(uuid)         to authenticated;
grant execute on function public.keeps_test(uuid)        to authenticated;
grant execute on function public.keeps_paper(uuid)       to authenticated;
grant execute on function public.test_is_archived(uuid)  to authenticated;
grant execute on function public.paper_is_archived(uuid) to authenticated;

-- mock_sets: the 0015 read, plus "not archived, or this student keeps it".
drop policy if exists mock_sets_select_live on public.mock_sets;
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
      and (archived_at is null or public.keeps_set(mock_sets.id))
    )
  );

-- mock_tests: still "whoever may read the parent set", plus the test's own
-- archive state. The owner (teacher) always sees their own archived tests.
drop policy if exists mock_tests_select_parent on public.mock_tests;
create policy mock_tests_select_parent on public.mock_tests
  for select to authenticated
  using (
    exists (
      select 1
      from public.mock_sets s
      where s.id = mock_tests.set_id
    )
    and (
      mock_tests.archived_at is null
      or public.keeps_test(mock_tests.id)
      or exists (
        select 1
        from public.mock_sets o
        where o.id = mock_tests.set_id
          and o.teacher_id = auth.uid()
      )
    )
  );

drop policy if exists papers_select_live on public.papers;
create policy papers_select_live on public.papers
  for select to authenticated
  using (
    auth.uid() = teacher_id
    or (
      status = 'live'
      and exists (
        select 1
        from public.teachers_public tp
        where tp.user_id = papers.teacher_id
      )
      and (archived_at is null or public.keeps_paper(papers.id))
    )
  );

-- batches: a member of an archived batch no longer sees it (its free sets are
-- withdrawn, section 5). The teacher always does.
drop policy if exists batches_select_own_or_member on public.batches;
create policy batches_select_own_or_member on public.batches
  for select to authenticated
  using (
    auth.uid() = teacher_id
    or (archived_at is null and public.is_batch_member(batches.id))
  );

-- has_test_access(): the free sample is no longer free once its test or set is
-- archived, unless this student already sat it (so they can read their own
-- review). Same signature, same grants as 0016.
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
        (t.is_free_sample and t.archived_at is null and s.archived_at is null)
        or exists (
          select 1
          from public.set_access a
          where a.set_id = t.set_id
            and a.user_id = auth.uid()
            and a.valid_until > now()
        )
        or (
          t.is_free_sample
          and exists (
            select 1
            from public.attempts att
            where att.test_id = t.id
              and att.user_id = auth.uid()
          )
        )
      from public.mock_tests t
      join public.mock_sets s on s.id = t.set_id
      where t.id = for_test
    ),
    false
  )
$$;

comment on function public.has_test_access(uuid) is
  'True when the signed-in user may read one mock test''s questions: the test is a free sample that is not archived (or they already sat it), or set_access has a row for its set that has not expired. The one place that rule is written. Issues 16-set-access-mock-list, 45-keep-money-and-scores.';

grant execute on function public.has_test_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. No new sitting on an archived test or paper
-- ---------------------------------------------------------------------------
--
-- RESTRICTIVE and INSERT only, like attempts_mock_needs_access (0017): the
-- UPDATE path is how an open sitting is submitted, and archiving a test in the
-- middle of an exam must not throw away the score a student has just earned.
drop policy if exists attempts_no_new_on_archived on public.attempts;
create policy attempts_no_new_on_archived on public.attempts
  as restrictive
  for insert to authenticated
  with check (
    (attempts.test_id is null or not public.test_is_archived(attempts.test_id))
    and (attempts.paper_id is null or not public.paper_is_archived(attempts.paper_id))
  );

comment on policy attempts_no_new_on_archived on public.attempts is
  'A new sitting cannot start on an archived test or an archived paper. An archived set does not block a student who holds access. Open sittings still submit, and old results stay. Issue 45-keep-money-and-scores.';

-- ---------------------------------------------------------------------------
-- 7. Nobody can START buying an archived set
-- ---------------------------------------------------------------------------
--
-- A trigger, not an edit of start_set_purchase() (scope guard: payment logic is
-- untouched). Same errcode and text as the function's own "set not found", so
-- the checkout route's existing mapping gives the student the usual answer.
-- INSERT only: an in-flight 'created' purchase still gets paid and granted by
-- the webhook, which UPDATEs.
create or replace function public.purchases_refuse_archived_set()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.mock_sets s
    where s.id = new.set_id and s.archived_at is not null
  ) then
    raise exception 'mock set not found' using errcode = 'PP404';
  end if;
  return new;
end;
$$;

comment on function public.purchases_refuse_archived_set() is
  'Refuses a NEW purchase row for an archived set, with the same PP404 as start_set_purchase() uses for an unknown set. Issue 45-keep-money-and-scores.';

drop trigger if exists purchases_refuse_archived_set on public.purchases;
create trigger purchases_refuse_archived_set
  before insert on public.purchases
  for each row execute function public.purchases_refuse_archived_set();

-- ---------------------------------------------------------------------------
-- 5. Batches: archive withdraws batch-sourced set_access
-- ---------------------------------------------------------------------------
--
-- refresh_batch_access() (0019) is the ONE place a batch grant is written or
-- removed, and it is declarative: "does any batch this user is still in give
-- this set away?". It now also asks "and is that batch live?". The member and
-- set triggers from 0019 already call it, so a member who joins an archived
-- batch gets nothing, and the new trigger below calls it for everyone in the
-- batch when archived_at moves in either direction.
create or replace function public.refresh_batch_access(for_user uuid, for_set uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.batch_members m
    join public.batch_sets bs on bs.batch_id = m.batch_id
    join public.batches b on b.id = m.batch_id
    where m.user_id = for_user
      and bs.set_id = for_set
      and b.archived_at is null
  ) then
    insert into public.set_access (user_id, set_id, source, valid_until)
    values (for_user, for_set, 'batch', 'infinity')
    on conflict (user_id, set_id, source)
      do update set valid_until = 'infinity';
  else
    -- `source = 'batch'` and nothing else. A purchase is not a batch's to
    -- take away.
    delete from public.set_access
    where user_id = for_user
      and set_id = for_set
      and source = 'batch';
  end if;
end;
$$;

comment on function public.refresh_batch_access(uuid, uuid) is
  'Makes set_access agree with batch_members + batch_sets for one (user, set) pair, counting only batches that are not archived. Declarative, so two batches granting the same set survive one of them going. Only the triggers call it. Issues 19-batches, 45-keep-money-and-scores.';

revoke all on function public.refresh_batch_access(uuid, uuid) from public;
revoke all on function public.refresh_batch_access(uuid, uuid) from anon;
revoke all on function public.refresh_batch_access(uuid, uuid) from authenticated;

create or replace function public.batches_archive_sync_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in
    select m.user_id, bs.set_id
    from public.batch_members m
    join public.batch_sets bs on bs.batch_id = m.batch_id
    where m.batch_id = new.id
  loop
    perform public.refresh_batch_access(r.user_id, r.set_id);
  end loop;
  return null;
end;
$$;

comment on function public.batches_archive_sync_access() is
  'Archiving a batch withdraws the set_access it handed out; restoring it hands them back. Goes through refresh_batch_access(), the one writer of batch grants. Issue 45-keep-money-and-scores.';

drop trigger if exists batches_sync_access_on_archive on public.batches;
create trigger batches_sync_access_on_archive
  after update of archived_at on public.batches
  for each row
  when (old.archived_at is distinct from new.archived_at)
  execute function public.batches_archive_sync_access();

-- join_batch(): an archived batch cannot be joined. Same text as 0019 plus the
-- archived filter; a code for an archived batch answers like an unknown code.
create or replace function public.join_batch(for_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_batch uuid;
begin
  if v_me is null then
    raise exception 'sign in to join a batch' using errcode = '42501';
  end if;

  select b.id
    into v_batch
    from public.batches b
    where b.join_code = upper(btrim(coalesce(for_code, '')))
      and b.archived_at is null;

  if v_batch is null then
    raise exception 'no batch has that join code' using errcode = 'P0002';
  end if;

  -- Joining twice is a double tap on a slow connection, not an error.
  insert into public.batch_members (batch_id, user_id)
  values (v_batch, v_me)
  on conflict (batch_id, user_id) do nothing;

  return v_batch;
end;
$$;

comment on function public.join_batch(text) is
  'Trade a batch join code for a membership row (V2). The only writer of batch_members. Returns the batch id. Raises P0002 for a code nobody has or whose batch is archived. Issues 19-batches, 45-keep-money-and-scores.';

grant execute on function public.join_batch(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. No more hard delete by the teacher; remove_* / restore_* instead
-- ---------------------------------------------------------------------------
drop policy if exists mock_sets_delete_own  on public.mock_sets;
drop policy if exists mock_tests_delete_own on public.mock_tests;
drop policy if exists papers_delete_own     on public.papers;
drop policy if exists batches_delete_own    on public.batches;

-- Error codes the REST client switches on:
--   42501 nobody is signed in
--   P0002 no such row, or not yours (a stranger learns nothing)
--   55000 restore window (30 days) is over
-- Return values: remove_* -> 'deleted' | 'archived'; restore_* -> 'restored'.

-- A concurrent purchase can slip in between the count and the delete. The FK
-- (restrict) then refuses the delete, and the function falls back to archive
-- instead of failing the teacher's tap.

create or replace function public.remove_mock_set(for_set uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_owner uuid;
begin
  if v_me is null then
    raise exception 'sign in to remove a mock set' using errcode = '42501';
  end if;

  select s.teacher_id into v_owner
    from public.mock_sets s
    where s.id = for_set
    for update;
  if v_owner is null or v_owner <> v_me then
    raise exception 'mock set not found' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.purchases p where p.set_id = for_set)
     and not exists (select 1 from public.set_access a where a.set_id = for_set)
     and not exists (
       select 1
       from public.attempts att
       join public.mock_tests t on t.id = att.test_id
       where t.set_id = for_set
     )
  then
    begin
      delete from public.mock_sets s where s.id = for_set;
      return 'deleted';
    exception when foreign_key_violation or restrict_violation then
      null; -- something appeared a moment ago: archive below
    end;
  end if;

  update public.mock_sets s
    set archived_at = coalesce(s.archived_at, now())
    where s.id = for_set;
  return 'archived';
end;
$$;

create or replace function public.remove_mock_test(for_test uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_set   uuid;
  v_owner uuid;
begin
  if v_me is null then
    raise exception 'sign in to remove a mock test' using errcode = '42501';
  end if;

  select t.set_id, s.teacher_id into v_set, v_owner
    from public.mock_tests t
    join public.mock_sets s on s.id = t.set_id
    where t.id = for_test
    for update of t;
  if v_owner is null or v_owner <> v_me then
    raise exception 'mock test not found' using errcode = 'P0002';
  end if;

  -- A test inside a SOLD set is archived too, not only a test that was sat:
  -- the buyers paid for the set as it was.
  if not exists (select 1 from public.attempts att where att.test_id = for_test)
     and not exists (select 1 from public.purchases p where p.set_id = v_set)
     and not exists (select 1 from public.set_access a where a.set_id = v_set)
  then
    begin
      delete from public.mock_tests t where t.id = for_test;
      return 'deleted';
    exception when foreign_key_violation or restrict_violation then
      null;
    end;
  end if;

  update public.mock_tests t
    set archived_at = coalesce(t.archived_at, now())
    where t.id = for_test;
  return 'archived';
end;
$$;

create or replace function public.remove_paper(for_paper uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_owner uuid;
begin
  if v_me is null then
    raise exception 'sign in to remove a paper' using errcode = '42501';
  end if;

  select p.teacher_id into v_owner
    from public.papers p
    where p.id = for_paper
    for update;
  if v_owner is null or v_owner <> v_me then
    raise exception 'paper not found' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.attempts att where att.paper_id = for_paper) then
    begin
      delete from public.papers p where p.id = for_paper;
      return 'deleted';
    exception when foreign_key_violation or restrict_violation then
      null;
    end;
  end if;

  update public.papers p
    set archived_at = coalesce(p.archived_at, now())
    where p.id = for_paper;
  return 'archived';
end;
$$;

-- "No member ever" is read as "no member row": batch_members keeps no history
-- of people who left, and a leaver took nothing the batch can still lose.
create or replace function public.remove_batch(for_batch uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_owner uuid;
begin
  if v_me is null then
    raise exception 'sign in to remove a batch' using errcode = '42501';
  end if;

  select b.teacher_id into v_owner
    from public.batches b
    where b.id = for_batch
    for update;
  if v_owner is null or v_owner <> v_me then
    raise exception 'batch not found' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.batch_members m where m.batch_id = for_batch) then
    delete from public.batches b where b.id = for_batch;
    return 'deleted';
  end if;

  -- The AFTER UPDATE trigger withdraws the batch-sourced set_access.
  update public.batches b
    set archived_at = coalesce(b.archived_at, now())
    where b.id = for_batch;
  return 'archived';
end;
$$;

create or replace function public.restore_mock_set(for_set uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me       uuid := auth.uid();
  v_owner    uuid;
  v_archived timestamptz;
begin
  if v_me is null then
    raise exception 'sign in to restore a mock set' using errcode = '42501';
  end if;

  select s.teacher_id, s.archived_at into v_owner, v_archived
    from public.mock_sets s
    where s.id = for_set
    for update;
  if v_owner is null or v_owner <> v_me then
    raise exception 'mock set not found' using errcode = 'P0002';
  end if;

  if v_archived is null then
    return 'restored';
  end if;
  if v_archived < now() - interval '30 days' then
    raise exception 'the 30 day restore window is over' using errcode = '55000';
  end if;

  update public.mock_sets s set archived_at = null where s.id = for_set;
  return 'restored';
end;
$$;

create or replace function public.restore_mock_test(for_test uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me       uuid := auth.uid();
  v_owner    uuid;
  v_archived timestamptz;
begin
  if v_me is null then
    raise exception 'sign in to restore a mock test' using errcode = '42501';
  end if;

  select s.teacher_id, t.archived_at into v_owner, v_archived
    from public.mock_tests t
    join public.mock_sets s on s.id = t.set_id
    where t.id = for_test
    for update of t;
  if v_owner is null or v_owner <> v_me then
    raise exception 'mock test not found' using errcode = 'P0002';
  end if;

  if v_archived is null then
    return 'restored';
  end if;
  if v_archived < now() - interval '30 days' then
    raise exception 'the 30 day restore window is over' using errcode = '55000';
  end if;

  update public.mock_tests t set archived_at = null where t.id = for_test;
  return 'restored';
end;
$$;

create or replace function public.restore_paper(for_paper uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me       uuid := auth.uid();
  v_owner    uuid;
  v_archived timestamptz;
begin
  if v_me is null then
    raise exception 'sign in to restore a paper' using errcode = '42501';
  end if;

  select p.teacher_id, p.archived_at into v_owner, v_archived
    from public.papers p
    where p.id = for_paper
    for update;
  if v_owner is null or v_owner <> v_me then
    raise exception 'paper not found' using errcode = 'P0002';
  end if;

  if v_archived is null then
    return 'restored';
  end if;
  if v_archived < now() - interval '30 days' then
    raise exception 'the 30 day restore window is over' using errcode = '55000';
  end if;

  update public.papers p set archived_at = null where p.id = for_paper;
  return 'restored';
end;
$$;

create or replace function public.restore_batch(for_batch uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_me       uuid := auth.uid();
  v_owner    uuid;
  v_archived timestamptz;
begin
  if v_me is null then
    raise exception 'sign in to restore a batch' using errcode = '42501';
  end if;

  select b.teacher_id, b.archived_at into v_owner, v_archived
    from public.batches b
    where b.id = for_batch
    for update;
  if v_owner is null or v_owner <> v_me then
    raise exception 'batch not found' using errcode = 'P0002';
  end if;

  if v_archived is null then
    return 'restored';
  end if;
  if v_archived < now() - interval '30 days' then
    raise exception 'the 30 day restore window is over' using errcode = '55000';
  end if;

  -- The AFTER UPDATE trigger hands the batch's free sets back to its members.
  update public.batches b set archived_at = null where b.id = for_batch;
  return 'restored';
end;
$$;

comment on function public.remove_mock_set(uuid) is
  'Teacher removes a mock set: hard delete only when no purchase, no set_access and no attempt depend on it, otherwise archive. Returns deleted or archived. Owner only (P0002 for a stranger). Issue 45-keep-money-and-scores.';
comment on function public.remove_mock_test(uuid) is
  'Teacher removes a mock test: hard delete only when it has no attempt and its set has no purchase or access row, otherwise archive. Returns deleted or archived. Issue 45-keep-money-and-scores.';
comment on function public.remove_paper(uuid) is
  'Teacher removes a past paper: hard delete only when it has no attempt, otherwise archive. Returns deleted or archived. Issue 45-keep-money-and-scores.';
comment on function public.remove_batch(uuid) is
  'Teacher removes a batch: hard delete only when it has no member, otherwise archive (its batch set_access is withdrawn, its reports stay). Returns deleted or archived. Issue 45-keep-money-and-scores.';
comment on function public.restore_mock_set(uuid) is
  'Undo an archive within 30 days (55000 after that). Owner only. Issue 45-keep-money-and-scores.';
comment on function public.restore_mock_test(uuid) is
  'Undo an archive within 30 days (55000 after that). Owner only. Issue 45-keep-money-and-scores.';
comment on function public.restore_paper(uuid) is
  'Undo an archive within 30 days (55000 after that). Owner only. Issue 45-keep-money-and-scores.';
comment on function public.restore_batch(uuid) is
  'Undo an archive within 30 days (55000 after that). Owner only; the batch''s free sets return to its members. Issue 45-keep-money-and-scores.';

-- Supabase's default privileges have already granted EXECUTE to anon and
-- authenticated; these write to money-adjacent tables, so anon is shut out.
revoke all on function public.remove_mock_set(uuid)    from public, anon;
revoke all on function public.remove_mock_test(uuid)   from public, anon;
revoke all on function public.remove_paper(uuid)       from public, anon;
revoke all on function public.remove_batch(uuid)       from public, anon;
revoke all on function public.restore_mock_set(uuid)   from public, anon;
revoke all on function public.restore_mock_test(uuid)  from public, anon;
revoke all on function public.restore_paper(uuid)      from public, anon;
revoke all on function public.restore_batch(uuid)      from public, anon;

grant execute on function public.remove_mock_set(uuid)   to authenticated;
grant execute on function public.remove_mock_test(uuid)  to authenticated;
grant execute on function public.remove_paper(uuid)      to authenticated;
grant execute on function public.remove_batch(uuid)      to authenticated;
grant execute on function public.restore_mock_set(uuid)  to authenticated;
grant execute on function public.restore_mock_test(uuid) to authenticated;
grant execute on function public.restore_paper(uuid)     to authenticated;
grant execute on function public.restore_batch(uuid)     to authenticated;
