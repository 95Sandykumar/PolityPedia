/**
 * Teachers tab (issue 06-portfolio-follow).
 *
 * APPROVED teachers only, read on the server with the student's own access
 * token. The view behind the read is what strips the real name of an alias
 * teacher (PRD F-A5) and what filters out teachers who are still waiting for
 * an admin.
 *
 * Tapping a row opens `/t/<id>`, that teacher's portfolio.
 *
 * Issue 54b-read-errors-home-teachers: a FAILED read is no longer the same
 * screen as an empty one. "No teachers yet" on a broken read is the message a
 * student reads as "this app has nobody in it" and closes.
 *
 * Issue 67-teachers-filter-and-free-badge: the list now starts at the exams
 * this student picked at onboarding, which until now was collected and never
 * used (persona-1 gap 6). The filter lives in the URL, because the list is
 * read on the server:
 *   /teachers        the student's own exams
 *   /teachers?all=1  every approved teacher
 * The rows come from `teacher_cards` (0050), so each card also carries the
 * free-sample badge, and a teacher with a free sample sorts first. ONE request
 * for the whole list (B8): the badge and the exam ids are columns of that
 * view, so there is no per-teacher lookup and no second round trip.
 */
import { TeachersList } from '@/components/teachers-list';
import {
  readFollowedTeachersResult,
  readStudentContext,
  readTeacherCardsResult,
} from '@/lib/follows/student-page';
import { readOk, type ReadResult } from '@/lib/read-result';
import type { PublicTeacher, TeacherCard } from '@/lib/teachers/types';

export default async function TeachersPage({
  searchParams,
}: {
  /**
   * Next always passes this. It is optional only so the page can be called
   * with no query at all, which is the same thing as the default view.
   */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, configured, mode, examIds } = await readStudentContext();
  const query = (await searchParams) ?? {};

  // "Show all" when the URL asks for it, AND when there is no exam to filter
  // by. The reader fails CLOSED on an empty list of ids, so asking it to
  // filter by nothing would hide EVERY teacher and give no reason. The student
  // layout sends a student with no exams to onboarding, so this is a guard,
  // not a path anybody should walk.
  const showAll = query.all !== undefined || examIds.length === 0;

  // The followed list is read too, only so a row can say "Following" (student-ui).
  // `ok` and `data` apart, so a read that FAILED can never reach the list as an
  // empty one.
  const [read, followedRead]: [ReadResult<TeacherCard[]>, ReadResult<PublicTeacher[]>] = configured
    ? await Promise.all([
        readTeacherCardsResult(session, showAll ? {} : { examIds }),
        readFollowedTeachersResult(session),
      ])
    : [readOk<TeacherCard[]>([]), readOk<PublicTeacher[]>([])];

  // The follow read only decorates a row with a "Following" pill, so its own
  // failure is NOT this screen's failure: a correct list with no pills is still
  // true, while hiding every approved teacher over a missing pill is not.
  const followedIds = followedRead.ok ? followedRead.data.map((teacher) => teacher.userId) : [];

  return (
    <TeachersList
      teachers={read.ok ? read.data : []}
      failed={!read.ok}
      titleKey="teachers.title"
      // Two different empty states, because they mean two different things:
      // "nobody teaches your exams" has a next step (Show all), "no teachers
      // yet" does not.
      emptyKey={showAll ? 'teachers.none' : 'teachers.noneForExams'}
      mode={mode}
      configured={configured}
      followedIds={followedIds}
      examFilter={showAll ? 'all' : 'mine'}
    />
  );
}
