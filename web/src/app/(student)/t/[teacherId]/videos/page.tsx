/**
 * `/t/<teacherId>/videos`, the student view (issue 08-videos-tile).
 *
 * Issue 06 wired this tile up with a placeholder. This slice fills it: the
 * teacher's YouTube links, each with its thumbnail and title (V6, PRD F-C1).
 *
 * Both reads run HERE, on the server, with the student's own access token out
 * of the httpOnly session cookie. The teacher comes from the `teachers_public`
 * VIEW, so an alias real name never leaves Postgres (PRD F-A5), and the videos
 * come back EMPTY when that teacher is on No show, because the
 * `teacher_videos_select_visible` policy in 0008 says so.
 *
 * A read that FAILED is told apart from one that came back empty
 * (issue 54c-read-errors-saved-practice-media). Both reads sit in one probe,
 * so one error state covers both, and it is checked BEFORE the not-found line:
 * "we could not read this" and "there is no such teacher" are different
 * answers, and only one of them is worth a Retry button.
 */
import { ReadError } from '@/components/read-error';
import { StudentVideos } from '@/components/student-videos';
import { BackLink, PageHeader } from '@/components/student-ui';
import { readStudentContext } from '@/lib/follows/student-page';
import { readStudentVideosResult } from '@/lib/videos/page-data';
import { labels } from '@/lib/i18n';

export default async function TeacherVideosPage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const { session, configured, mode } = await readStudentContext();
  // `ok` and `data` apart, so a read that FAILED can never reach the screen as
  // an empty one.
  const read = configured
    ? await readStudentVideosResult(session, teacherId)
    : ({ ok: true, data: { teacher: null, videos: [] } } as const);

  // The read broke. Say so and offer the one way out, rather than claim this
  // teacher has no videos or does not exist.
  if (!read.ok) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink href={`/t/${teacherId}`} mode={mode} />
        <section className="flex flex-col gap-4">
          <PageHeader titleKey="videos.title" mode={mode} />
          <ReadError mode={mode} />
        </section>
      </div>
    );
  }

  const { teacher, videos } = read.data;

  // No teacher: not approved, not real, or Supabase is not set up. One line,
  // no stack trace, and the nav is still there (DESIGN.md section 9, Empty).
  if (!teacher) {
    const key = configured ? 'portfolio.notFound' : 'videos.notConfigured';
    return (
      <section className="flex flex-col gap-3">
        <h1 role="status" className="text-[22px] leading-7 font-bold">
          {labels(key, mode).map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </h1>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <BackLink href={`/t/${teacherId}`} mode={mode} />
      <StudentVideos teacher={teacher} videos={videos} mode={mode} configured={configured} />
    </div>
  );
}
