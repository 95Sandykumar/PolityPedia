/**
 * Me tab (issue 04-exams-onboarding).
 *
 * Holds the Language setting, which DESIGN.md D6 says is the only language
 * toggle in the app apart from the first sign-in screen. The saved value comes
 * from `profiles.lang`, so it is the same on every device.
 */
import { cookies } from 'next/headers';
import { LanguageSetting } from '@/components/language-setting';
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
    </section>
  );
}
