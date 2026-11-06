/**
 * Teacher > AI explanations: correct the AI text on your own questions
 * (issue 24-revision-teacher-edit).
 *
 * F7 is the human gate on AI text, and F-F4 names the human: the teacher whose
 * question it is. This page is where they stand.
 *
 * The middleware already keeps non-teachers out of `/teacher/*`, and sends a
 * teacher who is not approved yet to `/teacher/pending` (issue 05). This page
 * therefore only ever renders for an approved teacher, and the route handler
 * plus the `ai_explanations_update_owner` policy check it again anyway.
 *
 * The list is read HERE, on the server, with the teacher's own access token
 * out of the httpOnly session cookie, so Postgres RLS decides the rows. The
 * browser never holds a key.
 *
 * `readStudentContext` is reused for the session plus the saved language: it
 * reads `profiles.lang`, which every role has, so a teacher sees their own
 * labels in their own language like everybody else.
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 */
import { TeacherExplanations } from '@/components/teacher-explanations';
import { readMyExplanations } from '@/lib/ai/teacher-page';
import type { TeacherExplanation } from '@/lib/ai/teacher-edit';
import { readStudentContext } from '@/lib/follows/student-page';

export default async function TeacherExplanationsPage() {
  const { session, configured, mode } = await readStudentContext();
  const explanations: TeacherExplanation[] = configured ? await readMyExplanations(session) : [];

  // The page frame (nav, gutter, `<main>`) comes from `(dashboard)/layout.tsx`.
  return <TeacherExplanations explanations={explanations} mode={mode} configured={configured} />;
}
