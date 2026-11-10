/**
 * Practice tab. Student-ui pass (2026-11-06): was a "Coming soon" placeholder,
 * now a shortcut to the mock tests and past papers of the teachers the student
 * follows. Read on the server with the same reader Home uses.
 *
 * The read tells an EMPTY list from a FAILED one
 * (issue 54c-read-errors-saved-practice-media). Before, a Supabase hiccup sent
 * a student who follows three teachers to the Teachers tab to "find teachers",
 * which is the one thing they had already done.
 */
import { PracticeHub } from '@/components/practice-hub';
import { readFollowedTeachersResult, readStudentContext } from '@/lib/follows/student-page';

export default async function PracticePage() {
  const { session, configured, mode } = await readStudentContext();
  // `ok` and `data` apart, so a read that FAILED can never reach the hub as an
  // empty one.
  const read = configured
    ? await readFollowedTeachersResult(session)
    : ({ ok: true, data: [] } as const);

  return (
    <PracticeHub
      teachers={read.ok ? read.data : []}
      failed={!read.ok}
      mode={mode}
      configured={configured}
    />
  );
}
