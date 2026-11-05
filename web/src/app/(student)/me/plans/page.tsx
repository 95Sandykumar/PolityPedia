/**
 * Me > Plans (issue 28-plan-subscriptions).
 *
 * A server component, so no Supabase key and no plan rule reaches the browser.
 * It reads two things with the STUDENT'S OWN access token out of the httpOnly
 * session cookie, and RLS is the gate for both:
 *
 *  * `entitlements`  -- through `entitlements_select_own` (0021), so the card
 *                       can show the paid-until date.
 *  * `subscriptions` -- through `subscriptions_select_own` (0028), so a
 *                       stopped plan can say "it works until the date above".
 *
 * Neither read can fail the page. An unreadable list draws the plain three
 * cards, because a student who cannot see a status should still be able to
 * subscribe.
 *
 * WHAT IS NOT HERE. The price. `PLAN_PRICE_INR` is a LABEL in the component,
 * and the bill comes from `plan_price_inr()` in Postgres (F-G2). Nothing on
 * this page sends an amount anywhere.
 */
import { cookies } from 'next/headers';
import { PlanPicker } from '@/components/plan-picker';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { createSupabasePlansClient } from '@/lib/plans/supabase-plans-client';
import { createSupabaseSubscriptionsClient } from '@/lib/plans/supabase-subscriptions-client';
import { createRazorpayPayments } from '@/lib/purchases/razorpay-payments';
import type { Entitlement, SubscriptionRow } from '@/lib/plans/types';
import { DEFAULT_MODE, labels, type LangMode } from '@/lib/i18n';

/** A plan page is per student and never cached. */
export const dynamic = 'force-dynamic';

export default async function MePlansPage() {
  const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
  const token = session?.accessToken ?? '';

  const plans = createSupabasePlansClient({ accessToken: token });
  const subscriptionsClient = createSupabaseSubscriptionsClient({ accessToken: token });
  const payments = createRazorpayPayments();

  // Both halves have to be up for a Subscribe button to mean anything: the
  // database quotes the price and Razorpay collects it.
  const configured = plans.isConfigured() && payments.isConfigured() && session !== null;

  let mode: LangMode = DEFAULT_MODE;
  let entitlements: Entitlement[] = [];
  let subscriptions: SubscriptionRow[] = [];

  if (session) {
    const exams = createSupabaseExamsClient();
    [mode, entitlements, subscriptions] = await Promise.all([
      exams.isConfigured()
        ? exams
            .readStudentState(session)
            .then((state) => state.lang)
            .catch(() => DEFAULT_MODE)
        : Promise.resolve(DEFAULT_MODE),
      // `.catch(() => [])` on purpose: see the header.
      plans.isConfigured() ? plans.list(session.userId).catch(() => []) : Promise.resolve([]),
      subscriptionsClient.list().catch(() => []),
    ]);
  }

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-[22px] leading-7 font-bold">
        {labels('mePlans.title', mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </h1>
      <PlanPicker
        entitlements={entitlements}
        subscriptions={subscriptions}
        configured={configured}
        mode={mode}
      />
    </section>
  );
}
