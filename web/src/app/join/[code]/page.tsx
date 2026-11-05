/**
 * `/join/<code>`: the page a teacher's join link lands on (issue 19-batches).
 *
 * V2: "Student joins by link or code". The code travels in the PATH so the
 * whole thing is one tappable link in WhatsApp, and the field arrives already
 * filled.
 *
 * Outside the (student) group on purpose: a student following a link should see
 * the one job, not a bottom nav. `/join` is not in `GUARDED` either, so a
 * teacher's link is not a 403 for anybody.
 *
 * NOBODY SIGNED IN IS SENT TO SIGN IN. Joining needs an access token, because
 * `join_batch()` reads `auth.uid()`. Showing a dead Join button instead would
 * teach the student that the link is broken. The link stays in their chat, so
 * signing in and tapping it again is one step.
 *
 * Env is read here, on the server, inside the render, so the build needs no
 * environment variables (web/CLAUDE.md).
 */
import { redirect } from 'next/navigation';
import { JoinBatch } from '@/components/join-batch';
import { normalizeJoinCode } from '@/lib/batches/types';
import { SIGN_IN_PATH } from '@/lib/auth/guard';
import { readStudentContext } from '@/lib/follows/student-page';

export const metadata = { title: 'Join a batch | PolityPedia' };

export default async function JoinBatchPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const { session, configured, mode } = await readStudentContext();

  // No session: the Join button could not work, so do not draw one.
  if (!session) redirect(SIGN_IN_PATH);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center gap-3 px-4 py-6">
      <JoinBatch
        // A code that cannot be a join code leaves the field EMPTY rather than
        // pre-filling rubbish the student then has to clear.
        code={normalizeJoinCode(decodeURIComponent(code)) ?? ''}
        mode={mode}
        configured={configured}
      />
    </main>
  );
}
