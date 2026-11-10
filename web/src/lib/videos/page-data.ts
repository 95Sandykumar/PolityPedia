/**
 * The server reads behind the two video pages (issue 08-videos-tile).
 *
 * Server only. Every read runs HERE, on the server, with the caller's own
 * access token out of the httpOnly session cookie, so Postgres RLS decides the
 * rows and the browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT. A Supabase hiccup gives a page that still renders,
 * never a 500 on a teacher page. What it does NOT do any more is lie
 * (issue 54c-read-errors-saved-practice-media): `readStudentVideosResult`
 * tells an empty read from a failed one, so the page shows the shared error
 * state instead of "No videos yet" while the links sit there unread.
 *
 * The queries are the same queries as before: the same `readPublic` and the
 * same `listForTeacher` on the same clients, so the same columns and the same
 * order. The only new thing is a probe handed to the clients in place of
 * `fetch`, which remembers a non-ok status on the way past. The clients still
 * turn a 400 into an empty list inside themselves; the probe is what lets the
 * reader know it happened.
 */
import { readWithProbe, type ReadResult } from '@/lib/read-result';
import { createSupabaseVideosClient } from '@/lib/videos/supabase-videos-client';
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';
import type { AuthSession } from '@/lib/auth/types';
import type { PublicTeacher } from '@/lib/teachers/types';
import type { TeacherVideo } from './types';

/** Injected in tests only. Production passes nothing and the env is read lazily. */
export interface VideosReadOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function videosClient(
  session: AuthSession | null,
  options: VideosReadOptions = {},
  fetchImpl?: typeof fetch,
) {
  return createSupabaseVideosClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
    ...(options.env ? { env: options.env } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export interface StudentVideosData {
  /** Null when there is no approved teacher with that id. */
  teacher: PublicTeacher | null;
  /**
   * Already filtered by Postgres. Empty for a teacher on No show, because the
   * `teacher_videos_select_visible` policy returns 0 rows for them.
   */
  videos: TeacherVideo[];
}

/**
 * One teacher plus the videos this student may see, and whether the read
 * worked.
 *
 * TWO queries sit inside ONE probe: the teacher, then their videos. EITHER one
 * failing makes the whole thing a failure, because "this teacher has no
 * videos" and "we could not read this teacher's videos" are the same picture
 * on the screen and only one of them is true.
 *
 * A teacher who is simply NOT THERE (0 rows, status 200) is still an OK read:
 * not approved, or not real. The page keeps its own not-found line for that.
 */
export async function readStudentVideosResult(
  session: AuthSession | null,
  teacherId: string,
  options: VideosReadOptions = {},
): Promise<ReadResult<StudentVideosData>> {
  return readWithProbe<StudentVideosData>(async (fetchImpl) => {
    // The VIEW, never the table: that is what strips an alias teacher's real
    // name and hides a teacher who is not approved (0005, PRD F-A5).
    const teacher = await createSupabaseTeachersClient({
      accessToken: session?.accessToken ?? '',
      ...(options.env ? { env: options.env } : {}),
      fetchImpl,
    })
      .readPublic(teacherId)
      .catch(() => null);
    if (!teacher) return { teacher: null, videos: [] };

    // Asked for either way. Postgres answers with 0 rows on No show, so the
    // page never has to decide what the student is allowed to read.
    const videos = await videosClient(session, options, fetchImpl)
      .listForTeacher(teacher.userId)
      .catch(() => [] as TeacherVideo[]);

    return { teacher, videos };
  }, options.fetchImpl);
}

/** One teacher plus their videos, for callers that have no error state yet. */
export async function readStudentVideos(
  session: AuthSession | null,
  teacherId: string,
  options: VideosReadOptions = {},
): Promise<StudentVideosData> {
  const read = await readStudentVideosResult(session, teacherId, options);
  return read.ok ? read.data : { teacher: null, videos: [] };
}

export interface TeacherVideosData {
  videos: TeacherVideo[];
  /** `teachers.videos_visible`. True when there is nothing to read. */
  visible: boolean;
}

/** The caller's own videos and their own Show / No show state. */
export async function readMyVideos(session: AuthSession | null): Promise<TeacherVideosData> {
  const client = videosClient(session);
  const [videos, visible] = await Promise.all([
    client.listMine().catch(() => [] as TeacherVideo[]),
    // Fails OPEN to Show, which is the column default in 0005. A failed read
    // must not look like the teacher switched their videos off.
    client.readVisible().catch(() => true),
  ]);
  return { videos, visible };
}
