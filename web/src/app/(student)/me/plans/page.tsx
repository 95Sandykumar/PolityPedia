/**
 * Plans, placeholder (issue 23-revision-screen).
 *
 * The Rs 100 card on the Revision (AI) screen needs somewhere for Subscribe
 * to go, and a button that 404s is worse than a page that says "soon". Issue
 * 28 builds the real thing here ("Plan page on the Me tab") with Razorpay
 * behind it; this file is eight lines of honesty until then.
 *
 * The path is `PLANS_PATH` in `@/lib/ai/revision-screen`, so issue 28 has one
 * constant to keep and no link to hunt for.
 */
import { readStudentContext } from '@/lib/follows/student-page';
import { labels, plain } from '@/lib/i18n';

export default async function StudentPlansPage() {
  const { mode } = await readStudentContext();

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-[22px] leading-7 font-bold">
        {labels('plans.title', mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </h1>

      <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3">
        <p className="text-base font-medium">{plain('plans.planAi', mode)}</p>
        <p className="text-base font-medium">{plain('plans.planPro', mode)}</p>
      </div>

      <p role="status" className="text-base text-muted-foreground">
        {plain('revision.plansSoon', mode)}
      </p>
    </section>
  );
}
