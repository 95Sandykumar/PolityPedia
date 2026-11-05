/**
 * Student layout (issue 01-app-shell, onboarding gate added in 04).
 *
 * On first sign-in a student has no row in `student_exams`, so every student
 * tab sends them to /onboarding until they have picked at least one exam.
 * The gate lives here, in one place, instead of in the middleware, because the
 * answer needs a database read and the middleware runs on every asset path.
 *
 * A failed read is treated as "already onboarded", so a Supabase hiccup can
 * never trap a student in a redirect they cannot leave.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { StudentShell } from '@/components/student-shell';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { ONBOARDING_PATH } from '@/lib/exams/types';
import { DEFAULT_MODE, type LangMode } from '@/lib/i18n';

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
  const client = createSupabaseExamsClient();

  let mode: LangMode = DEFAULT_MODE;
  if (session && client.isConfigured()) {
    const state = await client
      .readStudentState(session)
      .catch(() => ({ lang: DEFAULT_MODE, hasExams: true }));
    if (!state.hasExams) redirect(ONBOARDING_PATH);
    mode = state.lang;
  }

  return <StudentShell mode={mode}>{children}</StudentShell>;
}
