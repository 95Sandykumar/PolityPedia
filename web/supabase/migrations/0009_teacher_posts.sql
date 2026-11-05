-- 0009_teacher_posts.sql  (issue 09-teacher-notifications)
--
-- V17 / PRD F-H1: a teacher posts a notice (priority, heading, link) and it
-- shows at the TOP of the Notifications tile. The nightly news from v0 sits
-- below these and is a later slice, so nothing about it is here.
--
-- OWNERSHIP. A post belongs to exactly one teacher, so every write policy is
-- `auth.uid() = teacher_id`. Teacher B can neither write in teacher A's name,
-- nor edit, nor delete, nor move a post of their own across to A (the update
-- policy has a WITH CHECK as well as a USING, which is what blocks the move).
--
-- WHO MAY READ. Any signed-in user reads the posts of an APPROVED teacher,
-- and a teacher always reads their own. Two select policies, because Postgres
-- ORs them:
--
--   * `teacher_posts_select_approved` checks `public.teachers_public`, NOT
--     `public.teachers`. A policy subquery runs as the CALLER, and a student
--     has no select policy on `teachers`, so a subquery over the table would
--     come back empty and hide every post. `teachers_public` is a view with
--     the OWNER's rights (0005) and it already filters `status = 'approved'`,
--     which is exactly the question being asked. Same reasoning, and the same
--     view, as the insert policy in 0006_follows.sql. 0005 runs first
--     (file-name order), so the view is there.
--   * `teacher_posts_select_own` keeps the teacher's own page working while
--     they are still waiting for an admin. Their drafts are visible to them
--     and to nobody else.
--
-- No insert policy for a non-teacher is needed: `teacher_id` references
-- `teachers.user_id`, so a student's own id has no row to point at and the
-- foreign key refuses it before RLS is even consulted.
--
-- NO ADMIN POLICY on purpose. Moderating somebody else's notice board is not
-- part of this slice, and an admin has no reason to need it to ship it.

create table if not exists public.teacher_posts (
  id         uuid        primary key default gen_random_uuid(),
  teacher_id uuid        not null references public.teachers (user_id) on delete cascade,
  priority   integer     not null default 0,
  heading    text        not null,
  link       text,
  created_at timestamptz not null default now(),
  -- 0 normal, 1 important, 2 urgent. Mirrored by `PRIORITIES` in
  -- `src/lib/posts/types.ts`; a change needs both.
  constraint teacher_posts_priority_check check (priority between 0 and 2),
  -- One line, not a paragraph (DESIGN.md section 1: minimum text).
  constraint teacher_posts_heading_check check (length(btrim(heading)) between 1 and 200),
  -- The link becomes an `href` in a student's page, so a `javascript:` or
  -- `data:` URL would be a script waiting to run. http and https only, and no
  -- whitespace. The app checks the same thing in `normalizeLink`; this is the
  -- copy that holds even if a write arrives by another road.
  constraint teacher_posts_link_check
    check (link is null or link ~ '^https?://[^[:space:]]+$')
);

comment on table public.teacher_posts is
  'Teacher notification posts. Highest priority then newest first. RLS: own rows for writes, approved teachers readable by any signed-in user. Issue 09-teacher-notifications.';
comment on column public.teacher_posts.priority is
  '0 normal, 1 important, 2 urgent. V17: these sit above the nightly news.';
comment on column public.teacher_posts.link is
  'Optional. http or https only, checked here as well as in the app, because it is rendered as an href.';

-- The one query every screen runs: this teacher's posts, loudest and newest
-- first. The Home feed asks the same way with `teacher_id in (...)`.
create index if not exists teacher_posts_feed_idx
  on public.teacher_posts (teacher_id, priority desc, created_at desc);

alter table public.teacher_posts enable row level security;

-- Any signed-in user reads an approved teacher's notices.
create policy teacher_posts_select_approved on public.teacher_posts
  for select to authenticated
  using (
    exists (
      select 1
      from public.teachers_public tp
      where tp.user_id = teacher_posts.teacher_id
    )
  );

-- A teacher reads their own, approved yet or not.
create policy teacher_posts_select_own on public.teacher_posts
  for select to authenticated
  using (auth.uid() = teacher_id);

create policy teacher_posts_insert_own on public.teacher_posts
  for insert to authenticated
  with check (auth.uid() = teacher_id);

-- USING hides another teacher's row (so an edit is a silent no-op) and WITH
-- CHECK refuses a row that would leave the caller's ownership.
create policy teacher_posts_update_own on public.teacher_posts
  for update to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy teacher_posts_delete_own on public.teacher_posts
  for delete to authenticated
  using (auth.uid() = teacher_id);
