/**
 * Teacher signup with an invite code (issue 05-teacher-invite-approval,
 * framed again in teacher-ui).
 *
 * The path is deliberately OUTSIDE the guarded `/teacher` prefix: the person
 * opening it is still a student holding a code, so the teacher guard would
 * send them away.
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 */
import { TeacherSignupForm } from '@/components/teacher-signup-form';
import { readSupabaseEnv } from '@/lib/auth/env';

export default function TeacherSignupPage() {
  return (
    <main className="mx-auto w-full max-w-[480px] px-4 py-8">
      <TeacherSignupForm configured={readSupabaseEnv() !== null} />
    </main>
  );
}
