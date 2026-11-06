-- storage-setup.sql
--
-- Storage buckets and their access rules. NOT in migrations/ on purpose: the
-- PGlite test harness has no `storage` schema (see the note at the top of
-- 0010_papers.sql and 0025_revision_audio.sql). Run once per Supabase project,
-- as the `postgres` role. Safe to run twice.
--
-- Applied to project fkcuqwywxpvoxgzszhdq (PolityPedia, ap-south-1) on 2026-11-06.
--
-- Both buckets are PRIVATE. The app never hands out a bucket URL: it calls the
-- storage API with the CALLER's own token (there is no service key in the
-- request path), so these policies are the real gate, the way RLS is for a
-- table. Each policy hands the decision to a table whose RLS already holds the
-- rule, so the two can never drift apart:
--
--   papers             read = the `papers` table's own select policy
--                      (live paper of an approved teacher, or your own row).
--   explanation-audio  read = the `ai_explanations` table's own select
--                      policies, which include the 0037 "no read during an
--                      open exam" restrictive policy. So the audio of an
--                      explanation is refused exactly when its text is
--                      (review finding N2).

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('papers',            'papers',            false, 52428800),  -- 50 MB
  ('explanation-audio', 'explanation-audio', false, 20971520)   -- 20 MB
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- ---------------------------------------------------------------------------
-- papers   (object path: <teacher uuid>/<file id>-<kind>.pdf)
-- ---------------------------------------------------------------------------
drop policy if exists "papers_upload_own_folder" on storage.objects;
create policy "papers_upload_own_folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'papers'
    and (storage.foldername(name))[1] = auth.uid()::text
    -- only an APPROVED teacher uploads (teachers_public lists approved ones)
    and exists (select 1 from public.teachers_public tp where tp.user_id = auth.uid())
  );

drop policy if exists "papers_read_visible" on storage.objects;
create policy "papers_read_visible"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'papers'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      -- the subquery runs as the caller, so papers_select_live decides
      or exists (
        select 1
        from public.papers p
        where p.pdf_questions_path = storage.objects.name
           or p.pdf_solutions_path = storage.objects.name
      )
    )
  );

-- ---------------------------------------------------------------------------
-- explanation-audio   (object path: explanations/<question uuid>/<lang>.mp3)
-- ---------------------------------------------------------------------------
drop policy if exists "audio_read_visible" on storage.objects;
create policy "audio_read_visible"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'explanation-audio'
    and exists (
      select 1
      from public.ai_explanations e
      where e.audio_path = storage.objects.name
    )
  );

-- Only the caller who holds the live audio claim writes the file
-- (claim_explanation_audio, 0032/0038, sets audio_status 'making' and
-- audio_claimed_by to the caller).
drop policy if exists "audio_write_claimant" on storage.objects;
create policy "audio_write_claimant"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'explanation-audio'
    and exists (
      select 1
      from public.ai_explanations e
      where e.question_id::text = (storage.foldername(name))[2]
        and (storage.foldername(name))[1] = 'explanations'
        and e.audio_status = 'making'
        and e.audio_claimed_by = auth.uid()
    )
  );

drop policy if exists "audio_overwrite_claimant" on storage.objects;
create policy "audio_overwrite_claimant"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'explanation-audio'
    and exists (
      select 1
      from public.ai_explanations e
      where e.question_id::text = (storage.foldername(name))[2]
        and e.audio_status = 'making'
        and e.audio_claimed_by = auth.uid()
    )
  );
