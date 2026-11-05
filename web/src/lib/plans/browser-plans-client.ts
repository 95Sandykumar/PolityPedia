/**
 * Browser-side AdminPlansClient (issue 21-plans-entitlements).
 *
 * The page never holds a Supabase key and never sees a token. It posts to our
 * own route handler; that handler reads the admin's access token out of the
 * httpOnly session cookie and lets Postgres RLS decide.
 *
 * Security: the error message is fixed, so a Postgres policy name is never
 * echoed back into the page.
 */
import type { AdminPlansClient, EndInput, GrantInput } from './types';

export const ADMIN_PLANS_PATH = '/api/admin/plans';

export function createBrowserPlansClient(fetchImpl?: typeof fetch): AdminPlansClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  async function send(method: 'POST' | 'DELETE', body: unknown): Promise<void> {
    const res = await doFetch(ADMIN_PLANS_PATH, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Plans request failed with status ' + res.status);
  }

  return {
    grant({ userId, plan, validUntil }: GrantInput) {
      return send('POST', { userId, plan, validUntil });
    },
    end({ userId, plan }: EndInput) {
      return send('DELETE', { userId, plan });
    },
  };
}
