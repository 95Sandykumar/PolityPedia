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
 */
import { ChevronRight } from 'lucide-react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { LanguageSetting } from '@/components/language-setting';
import { SignOutButton } from '@/components/sign-out-button';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { DEFAULT_MODE, labels, type LangMode } from '@/lib/i18n';

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

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-[22px] leading-7 font-bold">
        {labels('nav.me', mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </h1>
      <LanguageSetting value={mode} configured={configured} />

      <Link
        href="/me/plans"
        prefetch={false}
        className="inline-flex min-h-12 items-center justify-between gap-2 rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100"
      >
        <span>
          {labels('mePlans.title', mode).map((line, index) => (
            <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
              {line}
            </span>
          ))}
        </span>
        <ChevronRight aria-hidden="true" className="size-5 text-muted-foreground" />
      </Link>

      {session ? <SignOutButton mode={mode} /> : null}
    </section>
  );
}
