-- 0004_exams.sql  (issue 04-exams-onboarding)
--
-- Two tables with opposite rules.
--
-- `exams` is shared reference data: every signed-in user may read every row,
-- and there is no insert/update/delete policy on purpose, so the catalogue can
-- only change through a migration or an admin using the service key. A student
-- can never add a fake exam.
--
-- `student_exams` is private: a student reads, adds and drops only their own
-- rows. The primary key is both columns, so a pair can exist at most once.
--
-- Marking columns are nullable on purpose. NULL means "we do not know yet",
-- which is different from 0. PGT and TGT marking is unknown (PRD section 6).
-- `marking_unverified` carries PRD assumption AS5: UGC NET is believed to be
-- +2 with no negative marking, but the NTA notice has not been checked, so the
-- UI can label the number before it is confirmed.

create table if not exists public.exams (
  id                 uuid primary key default gen_random_uuid(),
  code               text        not null unique,
  name_en            text        not null,
  name_hi            text        not null,
  marks_correct      numeric(5, 2),
  marks_wrong        numeric(5, 2),
  duration_min       integer     check (duration_min is null or duration_min > 0),
  question_count     integer     check (question_count is null or question_count > 0),
  marking_unverified boolean     not null default false,
  created_at         timestamptz not null default now()
);

comment on table public.exams is
  'Exam catalogue with per-exam marking. RLS: readable by any signed-in user, writable only by a migration or the service key. Issue 04-exams-onboarding.';
comment on column public.exams.marking_unverified is
  'True when the marking scheme is believed but not confirmed against the exam body notice (PRD AS5).';

alter table public.exams enable row level security;

create policy exams_select_all on public.exams
  for select to authenticated
  using (true);

-- Seed. Fixed ids, so fixtures and later migrations can reference a row by id.
-- `on conflict (code) do nothing` keeps a re-run harmless.
insert into public.exams
  (id, code, name_en, name_hi, marks_correct, marks_wrong, duration_min, question_count, marking_unverified)
values
  ('a4000001-0000-4000-8000-000000000001',
   'ugc_net_pol_sci',
   'UGC NET Political Science',
   'यूजीसी नेट राजनीति विज्ञान',
   2, 0, null, null, true),

  ('a4000001-0000-4000-8000-000000000002',
   'cuet_pg_pol_sci_huqp18',
   'CUET PG Political Science (HUQP18)',
   'सीयूईटी पीजी राजनीति विज्ञान (HUQP18)',
   4, -1, 90, 75, false),

  ('a4000001-0000-4000-8000-000000000003',
   'pgt_pol_sci',
   'PGT Political Science',
   'पीजीटी राजनीति विज्ञान',
   null, null, null, null, false),

  ('a4000001-0000-4000-8000-000000000004',
   'tgt_social_science',
   'TGT Social Science',
   'टीजीटी सामाजिक विज्ञान',
   null, null, null, null, false)
on conflict (code) do nothing;

create table if not exists public.student_exams (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  exam_id    uuid        not null references public.exams (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, exam_id)
);

comment on table public.student_exams is
  'The exams one student is preparing for. RLS: own rows only. Issue 04-exams-onboarding.';

-- The student's own list is read by user_id, which the primary key already
-- covers. This index serves the other direction (who follows this exam).
create index if not exists student_exams_exam_id_idx on public.student_exams (exam_id);

alter table public.student_exams enable row level security;

create policy student_exams_select_own on public.student_exams
  for select to authenticated
  using (auth.uid() = user_id);

create policy student_exams_insert_own on public.student_exams
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy student_exams_delete_own on public.student_exams
  for delete to authenticated
  using (auth.uid() = user_id);

-- No update policy: both columns are the primary key, so a change is a delete
-- plus an insert, and both of those are already covered above.
