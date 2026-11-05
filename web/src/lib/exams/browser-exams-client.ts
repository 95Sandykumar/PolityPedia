/**
 * Browser-side exams client (issue 04-exams-onboarding).
 *
 * The page never holds a Supabase key and never sees a token. It posts to our
 * own route handlers; they read the httpOnly session cookie and call Supabase
 * with the user's access token, so RLS still decides every write.
 *
 * Security: the error message is fixed, so a Supabase response body is never
 * shown to the user.
 */
import type { LangMode } from '@/lib/i18n';
import type { BrowserExamsClient, OnboardingChoice } from './types';

export const ONBOARDING_API_PATH = '/api/onboarding';
export const LANG_PATH = '/api/me/lang';

export function createBrowserExamsClient(fetchImpl?: typeof fetch): BrowserExamsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  async function post(path: string, body: unknown): Promise<void> {
    const res = await doFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Save failed with status ' + res.status);
  }

  return {
    saveOnboarding(choice: OnboardingChoice) {
      return post(ONBOARDING_API_PATH, { examIds: [...choice.examIds], lang: choice.lang });
    },

    saveLang(lang: LangMode) {
      return post(LANG_PATH, { lang });
    },
  };
}
