/**
 * Student browse: `/t/<teacherId>/mocks` (issue 16-set-access-mock-list).
 *
 * The teacher's LIVE mock sets, each with this student's own locks, ticks and
 * scores (V12, F-E2). The tile itself came from issue 06; this slice fills it.
 *
 * Every read runs HERE, on the server, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides: a draft set never
 * reaches this page, and a locked test's QUESTIONS are refused even to a page
 * that asks for them, because of the restrictive policy in
 * `0016_set_access.sql`.
 *
 * The list itself (topic dropdown, Practice | Exam switch, the Unlock button)
 * is a client component, so the choices are state and not a page load.
 */
import { MockList } from '@/components/mock-list';
import { BackLink, PageHeader } from '@/components/student-ui';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMockList } from '@/lib/set-access/student-page';
import { plain } from '@/lib/i18n';

export default async function TeacherMocksPage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const { session, configured, mode } = await readStudentContext();

  const sets = configured ? await readMockList(session, teacherId) : [];

  return (
    <section className="flex flex-col gap-3">
      <BackLink href={`/t/${teacherId}`} mode={mode} />
      <PageHeader titleKey="tile.mocks" mode={mode} />

      {configured ? (
        <MockList sets={sets} teacherId={teacherId} mode={mode} />
      ) : (
        <p role="status" className="text-muted-foreground">
          {plain('mockList.notConfigured', mode)}
        </p>
      )}
    </section>
  );
}
