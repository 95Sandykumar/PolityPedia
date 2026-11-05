/**
 * First sign-in screen (issue 04-exams-onboarding).
 *
 * Outside the (student) group on purpose: no bottom nav yet, and the student
 * layout is what redirects here, so a nested route would loop.
 *
 * Env and the session are read here, on the server, inside the render, so the
 * build needs no environment variables (web/CLAUDE.md).
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SIGN_IN_PATH } from '@/lib/auth/guard';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { OnboardingForm } from '@/components/onboarding-form';
import type { Exam } from '@/lib/exams/types';
import { DEFAULT_MODE, type LangMode } from '@/lib/i18n';

export const metadata = { title: 'Get started | PolityPedia' };

export default async function OnboardingPage() {
  const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect(SIGN_IN_PATH);

  const client = createSupabaseExamsClient();
  const configured = client.isConfigured();

  let exams: Exam[] = [];
  let mode: LangMode = DEFAULT_MODE;
  if (configured) {
    // A read that fails must not block sign-up: the screen then shows the
    // "not ready" state instead of an empty exam list with a dead button.
    [exams, mode] = await Promise.all([
      client.listExams(session).catch(() => [] as Exam[]),
      client
        .readStudentState(session)
        .then((state) => state.lang)
        .catch(() => DEFAULT_MODE),
    ]);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center px-4 py-6">
      <OnboardingForm exams={exams} mode={mode} configured={configured && exams.length > 0} />
    </main>
  );
}
