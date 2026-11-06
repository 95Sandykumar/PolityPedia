/**
 * `/teacher/videos`: where a teacher pastes their YouTube links
 * (issue 08-videos-tile).
 *
 * Guarded by the middleware: `/teacher/*` needs role `teacher` AND an approved
 * status (guard.ts, issue 05). That is routing only; the real gate is the
 * `teacher_videos_*_own` policies in 0008.
 *
 * Both reads run HERE, on the server, with the teacher's own access token out
 * of the httpOnly session cookie, so the browser never holds a key.
 */
import { TeacherVideosManager } from '@/components/teacher-videos-manager';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMyVideos } from '@/lib/videos/page-data';

export default async function TeacherVideosDashboardPage() {
  // Session plus the saved language. The helper is named for the student
  // pages, but it only reads the session cookie and `profiles.lang`, which
  // every signed-in user has.
  const { session, configured, mode } = await readStudentContext();
  const { videos, visible } = configured
    ? await readMyVideos(session)
    : { videos: [], visible: true };

  // The page frame (nav, gutter, `<main>`) comes from `(dashboard)/layout.tsx`.
  return (
    <TeacherVideosManager
      videos={videos}
      visible={visible}
      mode={mode}
      configured={configured}
    />
  );
}
