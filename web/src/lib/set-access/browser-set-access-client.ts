/**
 * Browser-side `AdminSetAccessClient` (issue 16-set-access-mock-list).
 *
 * The page never holds a Supabase key and never sees a token. It posts to our
 * own route handler; that handler reads the admin's access token out of the
 * httpOnly session cookie and lets Postgres RLS decide.
 *
 * Security: the error message is fixed, so a Postgres policy name is never
 * echoed back into the page.
 */
import {
  ADMIN_SET_ACCESS_PATH,
  type AdminSetAccessClient,
  type GrantSetInput,
  type RevokeSetInput,
} from './types';

export function createBrowserSetAccessClient(fetchImpl?: typeof fetch): AdminSetAccessClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  async function send(method: 'POST' | 'DELETE', body: unknown): Promise<void> {
    const res = await doFetch(ADMIN_SET_ACCESS_PATH, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Set access request failed with status ' + res.status);
  }

  return {
    grant({ userId, setId, validUntil }: GrantSetInput) {
      return send('POST', { userId, setId, validUntil });
    },
    revoke({ userId, setId }: RevokeSetInput) {
      return send('DELETE', { userId, setId });
    },
  };
}
