/**
 * Teachers tab (issue 06-portfolio-follow).
 *
 * Every APPROVED teacher, read on the server from the `teachers_public` VIEW
 * with the student's own access token. The view is what strips the real name
 * of an alias teacher (PRD F-A5) and what filters out teachers who are still
 * waiting for an admin.
 *
 * Tapping a row opens `/t/<id>`, that teacher's portfolio.
 *
 * Issue 54b-read-errors-home-teachers: a FAILED read is no longer the same
 * screen as an empty one. "No teachers yet" on a broken read is the message a
 * student reads as "this app has nobody in it" and closes.
 */
import { TeachersList } from '@/components/teachers-list';
import {
  readApprovedTeachersResult,
  readFollowedTeachersResult,
  readStudentContext,
} from '@/lib/follows/student-page';
import { readOk, type ReadResult } from '@/lib/read-result';
import type { PublicTeacher } from '@/lib/teachers/types';

export default async function TeachersPage() {
  const { session, configured, mode } = await readStudentContext();
  // The followed list is read too, only so a row can say "Following" (student-ui).
  // `ok` and `data` apart, so a read that FAILED can never reach the list as an
  // empty one.
  const ok = readOk<PublicTeacher[]>([]);
  const [read, followedRead]: [ReadResult<PublicTeacher[]>, ReadResult<PublicTeacher[]>] =
    configured
      ? await Promise.all([
          readApprovedTeachersResult(session),
          readFollowedTeachersResult(session),
        ])
      : [ok, ok];

  // The follow read only decorates a row with a "Following" pill, so its own
  // failure is NOT this screen's failure: a correct list with no pills is still
  // true, while hiding every approved teacher over a missing pill is not.
  const followedIds = followedRead.ok ? followedRead.data.map((teacher) => teacher.userId) : [];

  return (
    <TeachersList
      teachers={read.ok ? read.data : []}
      failed={!read.ok}
      titleKey="teachers.title"
      emptyKey="teachers.none"
      mode={mode}
      configured={configured}
      followedIds={followedIds}
    />
  );
}
