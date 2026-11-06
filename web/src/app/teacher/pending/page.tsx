/**
 * Where a teacher waits for an admin (issue 05-teacher-invite-approval,
 * framed again in teacher-ui).
 *
 * The only page under `/teacher` that a teacher with `status = 'pending'` may
 * open. The middleware sends them here from every other teacher page.
 *
 * Reassuring and short: where they are in three steps, what to do (nothing),
 * and the one sentence that says an admin checks every new teacher.
 */
import { Hourglass } from 'lucide-react';
import { BrandMark, CARD, Lines, Steps } from '@/components/teacher-ui';
import { DEFAULT_MODE, plain } from '@/lib/i18n';

export default function TeacherPendingPage() {
  const mode = DEFAULT_MODE;
  return (
    <main className="mx-auto w-full max-w-[480px] px-4 py-8">
      <section className="flex flex-col gap-4">
        <BrandMark mode={mode} />

        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          >
            <Hourglass size={24} strokeWidth={2} />
          </span>
          <h1 className="text-[22px] leading-7 font-bold">
            <Lines keyName="teacherPending.title" mode={mode} />
          </h1>
        </div>

        <p role="status" className={`${CARD} p-4`}>
          {plain('teacherPending.body', mode)}
        </p>

        <div className={`${CARD} p-4`}>
          <Steps
            mode={mode}
            steps={[
              { key: 'teacherUi.stepCode', state: 'done' },
              { key: 'teacherUi.stepReview', state: 'now' },
              { key: 'teacherUi.stepOpen', state: 'next' },
            ]}
          />
        </div>

        <p className="text-sm text-muted-foreground">{plain('teacherUi.pendingNote', mode)}</p>
      </section>
    </main>
  );
}
