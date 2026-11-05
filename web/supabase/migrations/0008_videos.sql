-- 0008_videos.sql  (issue 08-videos-tile)
--
-- V6 / PRD F-C1: a teacher pastes YOUTUBE LINKS ONLY. We keep the 11-character
-- video id, the title we read once from the keyless oEmbed endpoint, and the
-- thumbnail URL. No embed, no captions, no YouTube Data API: nothing here
-- needs a key.
--
-- THE SHOW / NO SHOW RULE (V6, PRD F-C2). `teachers.videos_visible` already
-- exists (0005). This migration is where that boolean starts to BITE: a
-- student reads a teacher's videos only while it is true. That is enforced
-- HERE, in Postgres, not in a page, so a page bug cannot leak a list the
-- teacher switched off.
--
-- The select policy asks `public.teachers_public`, NOT `public.teachers`.
-- A policy subquery runs as the caller, and a student has no select policy on
-- `teachers`, so a subquery over the table would always come back empty and
-- every video would vanish. `teachers_public` is a view with the OWNER's
-- rights (0005), it already filters `status = 'approved'`, and it carries
-- `videos_visible` as a column. Exactly the question being asked. 0005 runs
-- first (file-name order), so the view is there.
--
-- Two SELECT policies sit on this table and Postgres ORs them, which is what
-- we want: the OWNER always reads their own list, No show included, because
-- otherwise a teacher could not manage the videos they just hid.

create table if not exists public.teacher_videos (
  id         uuid        primary key default gen_random_uuid(),
  teacher_id uuid        not null references public.teachers (user_id) on delete cascade,
  youtube_id text        not null,
  title      text,
  thumb_url  text,
  "position" integer     not null default 0,
  created_at timestamptz not null default now(),
  -- The exact shape YouTube uses: 11 characters of A-Z a-z 0-9 - _ . The app
  -- parser produces nothing else, and this makes a crafted id a 4xx instead
  -- of a stored row that later lands in an <img src>.
  constraint teacher_videos_youtube_id_check check (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  constraint teacher_videos_title_check     check (title is null or length(title) <= 300),
  constraint teacher_videos_position_check  check ("position" >= 0),
  -- One video appears once per teacher, so a double paste is refused by the
  -- database and not by a page check. Two teachers may both post the same
  -- video: each keeps their own copy, like past papers (PRD F-D1).
  constraint teacher_videos_unique_per_teacher unique (teacher_id, youtube_id)
);

comment on table public.teacher_videos is
  'YouTube links one teacher shows on their portfolio. RLS: the owner always; a student only while teachers.videos_visible is true. Issue 08-videos-tile.';
comment on column public.teacher_videos.youtube_id is
  'The 11-character YouTube video id. Parsed from a watch, youtu.be, shorts or embed link by src/lib/videos/youtube-url.ts.';
comment on column public.teacher_videos.title is
  'Read once from https://www.youtube.com/oembed (no key). Null when YouTube did not answer; the page then falls back to the teacher name.';
comment on column public.teacher_videos.thumb_url is
  'https://i.ytimg.com/vi/<id>/hqdefault.jpg. Stored, so a page never has to build a URL from user text.';
comment on column public.teacher_videos."position" is
  'Order the teacher put them in. Quoted everywhere, because POSITION is an SQL function name.';

-- Every read is "this teacher's videos, in order", so index that exactly.
create index if not exists teacher_videos_teacher_position_idx
  on public.teacher_videos (teacher_id, "position");

alter table public.teacher_videos enable row level security;

-- ---------------------------------------------------------------------------
-- The owner. Reads and writes their own rows, Show or No show.
-- ---------------------------------------------------------------------------
create policy teacher_videos_select_own on public.teacher_videos
  for select to authenticated
  using (auth.uid() = teacher_id);

create policy teacher_videos_insert_own on public.teacher_videos
  for insert to authenticated
  with check (auth.uid() = teacher_id);

-- `using` picks the rows they may change, `with check` the rows they may
-- leave behind. Both are needed: without the check a teacher could hand one
-- of their videos to somebody else by writing a new teacher_id.
create policy teacher_videos_update_own on public.teacher_videos
  for update to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create policy teacher_videos_delete_own on public.teacher_videos
  for delete to authenticated
  using (auth.uid() = teacher_id);

-- ---------------------------------------------------------------------------
-- A student. SELECT only, and only while the switch is on.
--
-- With `videos_visible = false` this subquery finds nothing, so the query
-- returns 0 ROWS: that is the "Coming soon" state of the issue, decided by the
-- database. The rows are never deleted, so switching back to Show brings the
-- same list straight back.
--
-- `teachers_public` also filters `status = 'approved'`, so a teacher who is
-- still waiting for an admin stays invisible here too, exactly like their
-- portfolio and their Follow button (0005, 0006).
-- ---------------------------------------------------------------------------
create policy teacher_videos_select_visible on public.teacher_videos
  for select to authenticated
  using (
    exists (
      select 1
      from public.teachers_public tp
      where tp.user_id = teacher_videos.teacher_id
        and tp.videos_visible
    )
  );

-- No policy for `anon` on purpose: a visitor signs in before they read a
-- teacher page, the same as `follows` in 0006.
