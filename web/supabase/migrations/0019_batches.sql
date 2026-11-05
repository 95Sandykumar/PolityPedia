-- 0019_batches.sql  (issue 19-batches)
--
-- design.md V2 and V3:
--
--   V2 "teacher creates many batches. A student can be in many batches.
--       Student joins by link or code. Teacher can remove a student."
--   V3 "teacher picks which of their mock sets a batch gets free."
--
-- Three tables and one idea. The idea is that a BATCH GRANT IS DERIVED.
--
-- `set_access` (0016) is the paywall: a row there is the only reason a student
-- may read a mock question. This file never asks a screen or a route to write
-- one. It writes `batch_members` and `batch_sets`, and TRIGGERS keep the
-- `source = 'batch'` rows of `set_access` in step with them.
--
-- WHY A TRIGGER AND NOT A ROUTE. Six things change who holds a batch grant: a
-- student joins, a student leaves, a teacher removes a student, a teacher adds
-- a free set, a teacher drops one, the batch is deleted. A route that writes
-- `set_access` by hand has to remember all six, forever, in two languages of
-- client code. A trigger cannot forget one, and it cannot be skipped by
-- calling the REST API directly.
--
-- WHY NOT A VIEW. `set_access` is read by `has_test_access()`, a policy on
-- `questions` and the student's mock list, and it also holds purchases and
-- admin grants. Turning it into a view would mean rewriting 0016 and every
-- reader, and issues 26 and 27 still need a real table to INSERT a purchase
-- into. The table stays; the batch rows inside it are maintained for you.
--
-- WHY `valid_until = 'infinity'`. A batch grant lasts exactly as long as the
-- membership, and the membership is a row, not a date. So the row says
-- "forever" and is DELETED the moment the membership or the free set goes.
-- 0016's one rule, `valid_until > now()`, keeps working untouched.
--
-- WHY `source` IS IN `set_access`'s PRIMARY KEY (0016 wrote it that way). A
-- student who bought set 1 AND sits in a batch that gives set 1 away has two
-- rows. Leaving the batch deletes one of them. The purchase survives, which is
-- the whole reason the key has three columns.
--
-- RECURSION. `batches` wants to know "is the caller a member?" and
-- `batch_members` wants to know "does the caller own the batch?". Writing both
-- as a policy subquery over the other table is an infinite loop in Postgres
-- (each policy triggers the other). Both questions are answered by small
-- SECURITY DEFINER functions instead, which read the table directly and so
-- are not themselves filtered by a policy. They return a BOOLEAN about an id
-- the caller already holds, so there is nothing to leak.
--
-- NO REPORTS HERE. Batch scores (V3's second half, F-B4) are issue 20.

-- ---------------------------------------------------------------------------
-- The join code
-- ---------------------------------------------------------------------------
--
-- Six characters out of an alphabet with no O, 0, I or 1. The code is read off
-- one phone screen and typed into another by a student on a bus, so a pair
-- that looks the same in a condensed font is a support ticket.
--
-- 32^6 is about 1.07 billion, which is far more than a teacher will ever make,
-- but "far more" is not "never": the function LOOKS for a free code and keeps
-- the UNIQUE constraint as the backstop. Without the look-up a collision would
-- surface as a failed insert on a screen that just said "Create batch".
--
-- SECURITY DEFINER, because the look-up has to see EVERY batch. A teacher's
-- own policy hides other teachers' rows, so a caller-rights check would be
-- blind to exactly the collisions it is there to catch, and would then hand
-- out a duplicate that the UNIQUE constraint rejects. It returns a code that
-- is free and nothing else, so it tells the caller nothing about anybody.
--
-- Created before `batches`: a PL/pgSQL body is resolved when it runs, not when
-- it is created, so the forward reference to the table is fine.

create or replace function public.new_join_code()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  -- 32 characters. No O/0 and no I/1.
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i int;
begin
  for attempt in 1..30 loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    if not exists (select 1 from public.batches b where b.join_code = code) then
      return code;
    end if;
  end loop;

  -- 30 misses in a row means the code space is full, which is a product
  -- problem and not something to paper over with a seventh character.
  raise exception 'could not allocate a join code' using errcode = '55000';
end;
$$;

comment on function public.new_join_code() is
  'A free 6-character batch join code from an alphabet with no O/0/I/1. SECURITY DEFINER so the collision check sees every batch, not just the caller''s. Issue 19-batches.';

grant execute on function public.new_join_code() to authenticated;

-- ---------------------------------------------------------------------------
-- batches
-- ---------------------------------------------------------------------------

create table if not exists public.batches (
  id         uuid        primary key default gen_random_uuid(),
  -- References `teachers.user_id`, not `auth.users`, so a student cannot own a
  -- batch even if a route forgot to check the role. Same shape as `mock_sets`.
  teacher_id uuid        not null references public.teachers (user_id) on delete cascade,
  name       text        not null,
  join_code  text        not null default public.new_join_code(),
  created_at timestamptz not null default now(),

  -- One line on a 360 px phone.
  constraint batches_name_check check (length(btrim(name)) between 1 and 60),

  -- V2: "Student joins by link or code", so the code is the address of the
  -- batch and two batches can never share one.
  constraint batches_join_code_unique unique (join_code),

  -- Upper-case and unambiguous, whoever wrote it. `join_batch()` upper-cases
  -- and trims what a student types, so this is the only shape that can match.
  constraint batches_join_code_check check (join_code ~ '^[A-HJ-NP-Z2-9]{6,12}$')
);

comment on table public.batches is
  'One teacher''s batch of students (V2). The join_code is its address: a student joins by link or code. RLS: the teacher reads and writes their own; a member reads the batch they are in. Issue 19-batches.';
comment on column public.batches.join_code is
  'What a student types or taps. Upper-case, no O/0/I/1, UNIQUE across the app. Default from new_join_code().';

-- The teacher's own list, newest first.
create index if not exists batches_teacher_idx
  on public.batches (teacher_id, created_at desc);

alter table public.batches enable row level security;

-- ---------------------------------------------------------------------------
-- batch_members  (V2: many-to-many, a student can be in many batches)
-- ---------------------------------------------------------------------------

create table if not exists public.batch_members (
  batch_id  uuid        not null references public.batches (id) on delete cascade,
  user_id   uuid        not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (batch_id, user_id)
);

comment on table public.batch_members is
  'Who is in which batch. Many-to-many (V2): a student can be in many batches. Written only by join_batch(); deleted by the student or by the batch''s teacher. Issue 19-batches.';

-- "Which batches am I in" for the student side. The teacher direction
-- (batch_id first) is the primary key's own prefix.
create index if not exists batch_members_user_idx on public.batch_members (user_id);

alter table public.batch_members enable row level security;

-- ---------------------------------------------------------------------------
-- batch_sets  (V3: the teacher picks which of their sets a batch gets free)
-- ---------------------------------------------------------------------------

create table if not exists public.batch_sets (
  batch_id uuid not null references public.batches (id) on delete cascade,
  set_id   uuid not null references public.mock_sets (id) on delete cascade,
  primary key (batch_id, set_id)
);

comment on table public.batch_sets is
  'Which mock sets one batch gets FREE (V3). A row here plus a row in batch_members is what the triggers turn into a set_access row with source = batch. Issue 19-batches.';

-- "Which batches give this set away", for the revoke path and a report later.
create index if not exists batch_sets_set_idx on public.batch_sets (set_id);

alter table public.batch_sets enable row level security;

-- ---------------------------------------------------------------------------
-- The two questions every policy below asks
-- ---------------------------------------------------------------------------
--
-- Both are SECURITY DEFINER and both return a boolean about an id the caller
-- already has in their hand. That is what breaks the policy recursion
-- described at the top of this file.
--
-- The parameter is `for_batch`, never `batch_id`, so it can never be read as
-- the column it is compared against.

create or replace function public.owns_batch(for_batch uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.batches b
    where b.id = for_batch
      and b.teacher_id = auth.uid()
  )
$$;

comment on function public.owns_batch(uuid) is
  'True when the signed-in user is the teacher who owns that batch. SECURITY DEFINER so a policy on batch_members can ask it without recursing into batches. Issue 19-batches.';

create or replace function public.is_batch_member(for_batch uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.batch_members m
    where m.batch_id = for_batch
      and m.user_id = auth.uid()
  )
$$;

comment on function public.is_batch_member(uuid) is
  'True when the signed-in user is in that batch. SECURITY DEFINER so a policy on batches can ask it without recursing into batch_members. Issue 19-batches.';

grant execute on function public.owns_batch(uuid) to authenticated;
grant execute on function public.is_batch_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- refresh_batch_access(): the one place a batch grant is written or removed
-- ---------------------------------------------------------------------------
--
-- Idempotent and declarative on purpose. It does not take "the student
-- joined" or "the set was dropped" as an input; it asks the question
--
--   "does ANY batch this user is still in give this set away?"
--
-- and then makes `set_access` say so. That is why two batches handing out the
-- same set work: leaving one of them re-asks the question, the answer is still
-- yes, and the row stays. A delta-based version would have deleted it.
--
-- SECURITY DEFINER, because it writes `set_access`, which no student and no
-- teacher may write (0016: read your own, admin writes by hand). The function
-- owner owns the table, so RLS does not apply inside it.
--
-- EXECUTE is revoked from the API roles below. It is not a hole even if it
-- were callable (the membership check is the gate, so a student calling it on
-- themselves would only ever DELETE their own stale row), but a function that
-- writes the paywall table has no business being reachable from a REST call.

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
    where m.user_id = for_user
      and bs.set_id = for_set
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
  'Makes set_access agree with batch_members + batch_sets for one (user, set) pair. Declarative, so two batches granting the same set survive one of them going. Only the triggers call it. Issue 19-batches.';

revoke all on function public.refresh_batch_access(uuid, uuid) from public;
revoke all on function public.refresh_batch_access(uuid, uuid) from anon;
revoke all on function public.refresh_batch_access(uuid, uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- The triggers
-- ---------------------------------------------------------------------------
--
-- `batch_members` changed: re-ask the question for every set that batch gives
-- away, AND for every set this user currently holds through a batch.
--
-- The second half is what makes DELETING A WHOLE BATCH safe. A batch delete
-- cascades into both child tables, and Postgres does not promise which child
-- goes first. If `batch_sets` were emptied first, the member trigger would
-- find no sets to re-check and the grant would be left behind forever. Asking
-- about the rows the user actually holds closes that door whichever order the
-- cascade picks, and it makes the trigger self-healing: any stale batch row is
-- re-checked the next time that student's membership moves.

create or replace function public.batch_members_sync_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch uuid;
  v_user  uuid;
  r       record;
begin
  if tg_op = 'DELETE' then
    v_batch := old.batch_id;
    v_user  := old.user_id;
  else
    v_batch := new.batch_id;
    v_user  := new.user_id;
  end if;

  for r in
    select bs.set_id from public.batch_sets bs where bs.batch_id = v_batch
    union
    select a.set_id from public.set_access a
      where a.user_id = v_user and a.source = 'batch'
  loop
    perform public.refresh_batch_access(v_user, r.set_id);
  end loop;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

comment on function public.batch_members_sync_access() is
  'Keeps set_access in step when a student joins, leaves or is removed. Also re-checks the grants that student already holds, so a cascaded batch delete cannot leave one behind whichever child table Postgres empties first. Issue 19-batches.';

create trigger batch_members_sync_access
  after insert or delete on public.batch_members
  for each row execute function public.batch_members_sync_access();

-- `batch_sets` changed: re-ask the question for every member of that batch.

create or replace function public.batch_sets_sync_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch uuid;
  v_set   uuid;
  r       record;
begin
  if tg_op = 'DELETE' then
    v_batch := old.batch_id;
    v_set   := old.set_id;
  else
    v_batch := new.batch_id;
    v_set   := new.set_id;
  end if;

  for r in select m.user_id from public.batch_members m where m.batch_id = v_batch loop
    perform public.refresh_batch_access(r.user_id, v_set);
  end loop;

  return null;
end;
$$;

comment on function public.batch_sets_sync_access() is
  'Keeps set_access in step when a teacher adds a free set to a batch or drops one (V3). Issue 19-batches.';

create trigger batch_sets_sync_access
  after insert or delete on public.batch_sets
  for each row execute function public.batch_sets_sync_access();

-- ---------------------------------------------------------------------------
-- join_batch(): the one way in
-- ---------------------------------------------------------------------------
--
-- A student has the CODE, not the batch id, and `batches_select` deliberately
-- hides a batch they are not in yet, so they cannot look the id up first. The
-- code is the capability, and this function is the only thing that trades it
-- for a membership row. There is no INSERT policy on `batch_members` at all,
-- so a student with a patched client and a stolen batch id still gets nowhere.
--
-- It returns the BATCH ID and never the row, so a student learns nothing about
-- a batch beyond the fact that they are now in it. The code they typed they
-- already knew.
--
-- Case and space are forgiven: the code arrives by WhatsApp and gets typed
-- with a space on the end.
--
-- The error codes are what the REST client switches on, because a message is
-- English prose that will be reworded:
--
--   42501 insufficient_privilege -> nobody is signed in
--   P0002 no_data_found          -> no batch has that code

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
    where b.join_code = upper(btrim(coalesce(for_code, '')));

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
  'Trade a batch join code for a membership row (V2). The only writer of batch_members: there is no INSERT policy, so the code is the capability. Returns the batch id. Raises P0002 for a code nobody has. Issue 19-batches.';

grant execute on function public.join_batch(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: batches
-- ---------------------------------------------------------------------------

-- The teacher sees their own. A student sees only the batches they are in, so
-- the join page can name the batch they just joined. A code nobody holds names
-- nothing.
create policy batches_select_own_or_member on public.batches
  for select to authenticated
  using (
    auth.uid() = teacher_id
    or public.is_batch_member(batches.id)
  );

create policy batches_insert_own on public.batches
  for insert to authenticated
  with check (auth.uid() = teacher_id);

-- Both halves: without `with check`, an update could rewrite `teacher_id` and
-- hand a batch, its students and its free sets to somebody else.
create policy batches_update_own on public.batches
  for update to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy batches_delete_own on public.batches
  for delete to authenticated
  using (auth.uid() = teacher_id);

-- ---------------------------------------------------------------------------
-- RLS: batch_members
-- ---------------------------------------------------------------------------

-- A student reads their own memberships. The batch's teacher reads the roll,
-- which is the "see students" half of the definition of done.
create policy batch_members_select_own_or_teacher on public.batch_members
  for select to authenticated
  using (
    auth.uid() = user_id
    or public.owns_batch(batch_members.batch_id)
  );

-- NO INSERT POLICY ON PURPOSE. `join_batch()` is the only writer, and it needs
-- the code. See its comment.

-- V2: "Teacher can remove a student", and a student may also walk out.
create policy batch_members_delete_own_or_teacher on public.batch_members
  for delete to authenticated
  using (
    auth.uid() = user_id
    or public.owns_batch(batch_members.batch_id)
  );

-- No update policy: `joined_at` is not anybody's to move, and both other
-- columns are the primary key, so a change there is a delete plus an insert.

-- ---------------------------------------------------------------------------
-- RLS: batch_sets
-- ---------------------------------------------------------------------------

-- The teacher manages the list. A member may read it, so a student can be told
-- WHY a set is open to them.
create policy batch_sets_select_teacher_or_member on public.batch_sets
  for select to authenticated
  using (
    public.owns_batch(batch_sets.batch_id)
    or public.is_batch_member(batch_sets.batch_id)
  );

-- V3: "the teacher picks which of THEIR mock sets a batch gets free". Both
-- halves are needed. Owning the batch is not enough, because giving away
-- another teacher's Rs 399 set would be taking money out of their pocket.
--
-- The subquery hits `public.mock_sets` and asks only about the CALLER'S own
-- rows, which `mock_sets_select_live` already allows, so no SECURITY DEFINER
-- helper is needed here.
create policy batch_sets_insert_own on public.batch_sets
  for insert to authenticated
  with check (
    public.owns_batch(batch_sets.batch_id)
    and exists (
      select 1
      from public.mock_sets s
      where s.id = batch_sets.set_id
        and s.teacher_id = auth.uid()
    )
  );

-- Dropping needs only the batch: if the set somehow stopped being the
-- teacher's, they must still be able to take it back off their own batch.
create policy batch_sets_delete_own on public.batch_sets
  for delete to authenticated
  using (public.owns_batch(batch_sets.batch_id));
