/**
 * Teacher portfolio, student view: `/t/<teacherId>` (issue 06-portfolio-follow).
 *
 * DESIGN.md section 7: every teacher page has its own URL, so back always
 * works. It sits in the `(student)` group, so the bottom nav stays put.
 *
 * The teacher is read HERE, on the server, from the `teachers_public` VIEW
 * with the student's own access token, so an alias teacher's real name never
 * leaves Postgres (PRD F-A5) and a teacher who is not approved yet is simply
 * not found.
 *
 * The follow state is read on the server too, so the button is right on first
 * paint and there is no flash of "Follow" for somebody already followed.
 *
 * Issue 07 adds the next exam date pill. The nearest FUTURE date is picked on
 * the server as well, so a past date never reaches the browser.
 */
import { TeacherPortfolio } from '@/components/teacher-portfolio';
import { readPortfolio, readStudentContext } from '@/lib/follows/student-page';
import { labels } from '@/lib/i18n';

export default async function TeacherPortfolioPage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const { session, configured, mode } = await readStudentContext();
  const { teacher, following, nextExam } = configured
    ? await readPortfolio(session, teacherId)
    : { teacher: null, following: false, nextExam: null };

  // No teacher: not approved, not real, or Supabase is not set up. One line,
  // no stack trace, and the nav is still there to go somewhere else
  // (DESIGN.md section 9, Empty).
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

  return (
    <TeacherPortfolio
      teacher={teacher}
      following={following}
      nextExam={nextExam}
      mode={mode}
      configured={configured}
    />
  );
}
