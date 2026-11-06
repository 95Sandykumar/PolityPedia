/**
 * Me tab (issue 04-exams-onboarding, Plans link added by
 * 28-plan-subscriptions).
 *
 * Holds the Language setting, which DESIGN.md D6 says is the only language
 * toggle in the app apart from the first sign-in screen. The saved value comes
 * from `profiles.lang`, so it is the same on every device.
 *
 * The Plans row is a LINK and not the plan cards themselves. DESIGN.md
 * section 2 asks for one clear action per screen, and the Plans page carries
 * three cards plus a gateway; folding it in here would make the Me tab the
 * busiest screen in the app. `prefetch={false}` for the same reason every link
 * in this app has it (B3: no viewport prefetch on 4G).
 *
 * Sign out (issue 33-session-refresh) is the last row, and only for somebody
 * who is actually signed in. It is the only way to clear the 7 day session
 * cookie off a shared phone.
 *
 * Student-ui pass (2026-11-06): the tab is now three labelled sections.
 * Account (who is signed in, and the plan they are on), Settings (language and
 * plans) and Session (sign out). The e-mail comes out of the student's own
 * access token, read on the server; it is shown and never used for anything.
 */
import { ChevronRight, CreditCard, Languages, LogOut, UserRound } from 'lucide-react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { LanguageSetting } from '@/components/language-setting';
import { SignOutButton } from '@/components/sign-out-button';
import { CARD, IconChip, Lines, PageHeader, SectionTitle } from '@/components/student-ui';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { emailFromToken, readPlanState } from '../_data/student-ui-data';

const PLAN_KEY: Record<string, MessageKey> = {
  ai: 'sui.mePlanAi',
  pro: 'sui.mePlanPro',
};

/** `en-IN` for both languages: numbers stay in Latin digits (DESIGN.md section 1). */
function paidUntil(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default async function MePage() {
  const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
  const client = createSupabaseExamsClient();
  const configured = client.isConfigured() && session !== null;

  let mode: LangMode = DEFAULT_MODE;
  if (configured && session) {
    mode = await client
      .readStudentState(session)
      .then((state) => state.lang)
      .catch(() => DEFAULT_MODE);
  }

  const plan = configured ? await readPlanState(session) : { plan: null, validUntil: null };
  const email = emailFromToken(session?.accessToken);
  const planKey: MessageKey = plan.plan ? (PLAN_KEY[plan.plan] ?? 'sui.mePlanFree') : 'sui.mePlanFree';
  const initial = (email ?? '?').charAt(0).toUpperCase();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader titleKey="nav.me" mode={mode} />

      <section aria-label={plain('sui.meAccount', mode)} className="flex flex-col gap-3">
        <SectionTitle Icon={UserRound} titleKey="sui.meAccount" mode={mode} />
        <div className={`${CARD} flex items-center gap-4 p-4`}>
          <span
            aria-hidden="true"
            className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[22px] leading-8 font-bold text-primary"
          >
            {initial}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm leading-5 text-muted-foreground">
              {plain('sui.meSignedInAs', mode)}
            </p>
            <p className="text-base leading-6 font-bold break-all">
              {session ? (email ?? plain('sui.meNoEmail', mode)) : '-'}
            </p>
            <p className="w-fit rounded-full bg-primary/10 px-2 text-sm leading-6 font-medium text-primary">
              {plain(planKey, mode)}
            </p>
          </div>
        </div>
      </section>

      <section aria-label={plain('sui.mePreferences', mode)} className="flex flex-col gap-3">
        <SectionTitle Icon={Languages} titleKey="sui.mePreferences" mode={mode} />
        <div className={`${CARD} p-4`}>
          <LanguageSetting value={mode} configured={configured} />
        </div>

        <Link
          href="/me/plans"
          prefetch={false}
          className={`${CARD} flex min-h-16 items-center gap-3 p-3 transition-colors duration-100`}
        >
          <IconChip Icon={CreditCard} />
          <span className="flex min-w-0 grow flex-col">
            <span className="text-base leading-6 font-medium">
              <Lines keyName="mePlans.title" mode={mode} />
            </span>
            <span className="text-sm leading-5 text-muted-foreground tabular-nums">
              {plain(planKey, mode)}
              {plan.validUntil ? ` · ${plain('mePlans.paidUntil', mode)} ${paidUntil(plan.validUntil)}` : ''}
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        </Link>
      </section>

      {session ? (
        <section aria-label={plain('sui.meSession', mode)} className="flex flex-col gap-3">
          <SectionTitle Icon={LogOut} titleKey="sui.meSession" mode={mode} />
          <SignOutButton mode={mode} />
          <p className="text-sm leading-5 text-muted-foreground">
            {plain('sui.meSignedOutHint', mode)}
          </p>
        </section>
      ) : null}
    </div>
  );
}
