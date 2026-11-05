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
 * Every read fails SOFT. A Supabase hiccup gives an empty list and a page that
 * still renders, never a 500 on a teacher page.
 */
import { createSupabaseVideosClient } from '@/lib/videos/supabase-videos-client';
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';
import type { AuthSession } from '@/lib/auth/types';
import type { PublicTeacher } from '@/lib/teachers/types';
import type { TeacherVideo } from './types';

function videosClient(session: AuthSession | null) {
  return createSupabaseVideosClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
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

/** One teacher plus the videos this student may see. */
export async function readStudentVideos(
  session: AuthSession | null,
  teacherId: string,
): Promise<StudentVideosData> {
  // The VIEW, never the table: that is what strips an alias teacher's real
  // name and hides a teacher who is not approved (0005, PRD F-A5).
  const teacher = await createSupabaseTeachersClient({
    accessToken: session?.accessToken ?? '',
  })
    .readPublic(teacherId)
    .catch(() => null);
  if (!teacher) return { teacher: null, videos: [] };

  // Asked for either way. Postgres answers with 0 rows on No show, so the
  // page never has to decide what the student is allowed to read.
  const videos = await videosClient(session)
    .listForTeacher(teacher.userId)
    .catch(() => []);

  return { teacher, videos };
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
