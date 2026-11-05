/**
 * Browser-side exam date client (issue 07-next-exam-date-teacher-shell).
 *
 * The page never holds a Supabase key and never sees a token. It posts to our
 * own route handler; that reads the teacher's access token out of the httpOnly
 * session cookie and lets Postgres RLS decide.
 *
 * Security: the thrown message is the HTTP status only, so a Postgres policy
 * name is never echoed back into the page.
 */
import type { BrowserTeacherExamsClient, TeacherExam } from './types';

export const TEACHER_EXAMS_PATH = '/api/teacher/exams';

export function createBrowserTeacherExamsClient(
  fetchImpl?: typeof fetch,
): BrowserTeacherExamsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);
  return {
    async save(items: readonly TeacherExam[]) {
      const res = await doFetch(TEACHER_EXAMS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
    },
  };
}
