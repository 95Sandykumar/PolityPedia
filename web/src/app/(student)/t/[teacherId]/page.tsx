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
 *
 * Student-ui pass (2026-11-06): the hero also gets the exams this teacher
 * teaches, and each tile gets a count. Both are extra read-only lookups that
 * fail soft: a failed one just leaves that line out.
 *
 * Issue 63-public-landing: this URL is what a teacher SHARES, so it is the
 * first PolityPedia page many students ever open, with no session cookie.
 * Logged out it now reads the same `teachers_public` view as the `anon` role
 * (0005 already grants that, so no migration) and shows the public profile
 * with "Sign in to follow". No teacher, or no Supabase: the landing pitch,
 * never the old "Teachers are not set up yet" (persona-1 gap 3).
 */
import { PublicLanding, PublicTeacherCard } from '@/components/public-landing';
import { ReadError } from '@/components/read-error';
import { TeacherPortfolio } from '@/components/teacher-portfolio';
import { readPortfolioResult, readStudentContext } from '@/lib/follows/student-page';
import { readPublicTeacher } from '@/lib/teachers/public-teacher';
import { readExamCatalogue } from '@/lib/teacher-exams/teacher-page';
import { labels } from '@/lib/i18n';
import {
  readPortfolioCounts,
  readTeacherExamNames,
} from '../../_data/student-ui-data';

export default async function TeacherPortfolioPage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const { session, configured, mode } = await readStudentContext();

  // Logged out: the public fields only, read as `anon`. The tiles are not
  // drawn at all, because every one of them needs a signed-in read.
  if (!session) {
    const shared = await readPublicTeacher(teacherId);
    return shared ? <PublicTeacherCard teacher={shared} mode={mode} /> : <PublicLanding mode={mode} />;
  }

  // `ok` and `data` apart, so a read that FAILED can never reach the screen as
  // a teacher who does not exist (issue 54-visible-read-errors).
  const read = configured
    ? await readPortfolioResult(session, teacherId)
    : ({ ok: true, data: { teacher: null, following: false, nextExam: null } } as const);

  // The read broke. Say so and offer the one way out: this student's teacher
  // IS there, and "This teacher is not here" is the worst thing to say to the
  // student who just typed their code.
  if (!read.ok) {
    return (
      <section className="flex flex-col gap-4">
        <ReadError mode={mode} />
      </section>
    );
  }

  const { teacher, following, nextExam } = read.data;

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

  const [counts, catalogue] = await Promise.all([
    readPortfolioCounts(session, teacher),
    readExamCatalogue(session),
  ]);
  const exams = await readTeacherExamNames(session, teacher.userId, catalogue);

  return (
    <TeacherPortfolio
      teacher={teacher}
      following={following}
      nextExam={nextExam}
      counts={counts}
      exams={exams}
      mode={mode}
      configured={configured}
    />
  );
}
