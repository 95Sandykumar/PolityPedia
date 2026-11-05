/**
 * Where a teacher waits for an admin (issue 05-teacher-invite-approval).
 *
 * The only page under `/teacher` that a teacher with `status = 'pending'` may
 * open. The middleware sends them here from every other teacher page.
 */
import { DEFAULT_MODE, labels, plain } from '@/lib/i18n';

export default function TeacherPendingPage() {
  const mode = DEFAULT_MODE;
  return (
    <main className="mx-auto w-full max-w-[560px] px-4 py-4">
      <section className="flex flex-col gap-3">
        <h1 className="text-[22px] leading-7 font-bold">
          {labels('teacherPending.title', mode).map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </h1>
        <p role="status" className="rounded-[10px] border border-border bg-card p-3">
          {plain('teacherPending.body', mode)}
        </p>
      </section>
    </main>
  );
}
