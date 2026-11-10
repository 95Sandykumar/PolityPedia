/**
 * The Notifications tile `/t/<teacherId>/news` (issue 09-teacher-notifications,
 * page first wired up by 06-portfolio-follow).
 *
 * V17 / PRD F-H1: the teacher's own posts, highest priority and newest first.
 * The nightly news from v0 goes BELOW them and is a later slice, so this page
 * is only the teacher's posts for now.
 *
 * The teacher is read first, from the `teachers_public` VIEW, so an alias
 * teacher's real name never leaves Postgres (PRD F-A5) and a teacher who is
 * not approved yet is simply not found. The posts are read with the student's
 * own access token, so the `teacher_posts_select_approved` policy is what
 * decides whether there is anything to see at all.
 *
 * DESIGN.md section 7: its own URL, so back always works. It sits in the
 * `(student)` group, so the bottom nav stays put.
 *
 * A read that FAILED is told apart from one that came back empty
 * (issue 54c-read-errors-saved-practice-media). "No notices yet" next to a
 * teacher who posted a form-date change this morning is the worst thing this
 * screen can say, so a broken read says so and offers Retry instead.
 */
import { PostList } from '@/components/post-list';
import { ReadError } from '@/components/read-error';
import { BackLink, PageHeader } from '@/components/student-ui';
import { readPortfolioResult, readStudentContext } from '@/lib/follows/student-page';
import { readTeacherPostsResult } from '@/lib/posts/server-posts';
import { labels } from '@/lib/i18n';

export default async function TeacherNewsPage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const { session, configured, mode } = await readStudentContext();

  // The teacher read comes back as a RESULT too, so a broken one shows the
  // shared error state instead of "This teacher is not here", which would stop
  // the page before the notice list below could say anything
  // (issue 54-visible-read-errors).
  const header = configured
    ? await readPortfolioResult(session, teacherId)
    : ({ ok: true, data: { teacher: null, following: false, nextExam: null } } as const);

  if (!header.ok) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink href={`/t/${teacherId}`} mode={mode} />
        <PageHeader titleKey="tile.news" mode={mode} />
        <ReadError mode={mode} />
      </section>
    );
  }

  const { teacher } = header.data;

  // No teacher: not approved, not real, or Supabase is not set up. One line,
  // no stack trace, and the nav is still there (DESIGN.md section 9, Empty).
  if (!teacher) {
    const key = configured ? 'portfolio.notFound' : 'teachers.notConfigured';
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

  // `ok` and `data` apart, so a read that FAILED can never reach the list as
  // an empty one.
  const read = await readTeacherPostsResult(session, teacher.userId);

  return (
    <section className="flex flex-col gap-4">
      <BackLink href={`/t/${teacherId}`} mode={mode} />
      <PageHeader title={teacher.displayName} mode={mode} />
      {/* The author is already the page title, so the rows do not repeat it. */}
      <PostList
        posts={read.ok ? read.data : []}
        failed={!read.ok}
        titleKey="tile.news"
        emptyKey="posts.none"
        mode={mode}
      />
    </section>
  );
}
