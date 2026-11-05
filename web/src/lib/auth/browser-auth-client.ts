/**
 * Browser-side AuthClient (issue 03-sign-in).
 *
 * The page never holds a Supabase key and never sees a token. It posts to our
 * own route handlers; they call Supabase and set the httpOnly session cookie.
 *
 * Security: the error message is fixed, so a wrong code is never echoed back.
 */
import type { BrowserAuthClient } from './types';

export const SEND_CODE_PATH = '/api/auth/send-code';
export const VERIFY_CODE_PATH = '/api/auth/verify-code';

export function createBrowserAuthClient(fetchImpl?: typeof fetch): BrowserAuthClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  async function post(path: string, body: unknown): Promise<void> {
    const res = await doFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Auth request failed with status ' + res.status);
  }

  return {
    sendEmailCode(email) {
      return post(SEND_CODE_PATH, { email });
    },
    verifyEmailCode(email, code) {
      return post(VERIFY_CODE_PATH, { email, code });
    },
  };
}
